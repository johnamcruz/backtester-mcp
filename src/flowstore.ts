import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { addDays, etDate, etDayBounds, globexRanges, weekday, type EtDate } from "./calendar.js";
import { EMPTY_L1, FlowEngine, BOOK_LEVELS, L1_STATE_GROUPING, type EngineCarry } from "./flowengine.js";
import { L1_TYPE } from "./events.js";
import { MINUTE_MS, newBucket, recordOf, type L1State, type MinuteRecord } from "./orderflow.js";
import { ParquetFile } from "./parquet.js";
import type { RollSchedule } from "./rolltable.js";
import { L1_COLUMNS, L2_COLUMNS, storeDir, writeAtomic, type DayFile, type SourceRef } from "./store.js";

/**
 * The order flow of the derived store: per ET day, the per-minute flow rows
 * (orderflow.ts) of the day's Globex hours, computed at build time by the history
 * engine (flowengine.ts) from the day's L1 and L2 rows, and read by get_bars.
 * Layout, next to the day files:
 *
 *   derived/<ROOT>/flow/YYYY-MM-DD.json.gz   one ET day's minute rows, and the engine state at its end
 *
 * A session runs over 00:00 ET, so the engine state (the book, the L1 state, the
 * OFI chain, the tick rule) is carried from one day file to the next, as the
 * quote state of the day files is; each file records the hash of the state it
 * started from, so a day is rebuilt when what came before it changed. The
 * manifest lists the days whose flow is current (`flow.days`), with FLOW_FORMAT:
 * a run pins the manifest, so its flow never changes under it.
 */

/** Bump when the computation or the file layout changes: the store's flow is then rebuilt. */
export const FLOW_FORMAT = 3;
/** NQ's tick: the book's price grid. */
export const FLOW_TICK = 0.25;

/** The manifest's flow section. */
export interface FlowSummary {
  format: number;
  tick: number;
  levels: number;
  /** How L1 rows are grouped into quote-OFI states (flowengine.ts#L1_STATE_GROUPING). */
  l1Grouping: string;
  /** ET days with a current flow file, oldest first. */
  days: EtDate[];
}

type Ref = Pick<SourceRef, "file" | "size" | "mtime" | "rowGroup" | "rows">;

/** One ET day's flow rows, by minute (columns). */
export interface FlowColumns {
  t: number[];
  bv: number[];
  sv: number[];
  volume: number[];
  trades: number[];
  vwap: Array<number | null>;
  high: Array<number | null>;
  low: Array<number | null>;
  maxPrint: Array<number | null>;
  /** Per minute: [size, buy volume, sell volume]. */
  sizes: Array<Array<[number, number, number]>>;
  ofiQuote: Array<number | null>;
  /** Time-weighted top-5 book imbalance; null on a day without L2. */
  imbalance: Array<number | null>;
  sideless: number[];
  /** L1 rows (quote changes and trades) in the minute: zero means no data. */
  l1Events: number[];
}

export interface FlowDay {
  format: number;
  root: string;
  date: EtDate;
  l1: Ref | null;
  l2: Ref | null;
  /** L2 rows in the day's hours: without them the imbalance is null. */
  book: boolean;
  startHash: string;
  endHash: string;
  minutes: FlowColumns;
  end: EngineCarry;
}

export const flowDayPath = (dataDir: string, root: string, date: EtDate) => join(storeDir(dataDir, root), "flow", `${date}.json.gz`);

const refOf = (r: SourceRef | null): Ref | null => (r ? { file: r.file, size: r.size, mtime: r.mtime, rowGroup: r.rowGroup, rows: r.rows } : null);
const sameRef = (a: Ref | null, b: SourceRef | null) => JSON.stringify(a) === JSON.stringify(refOf(b));
export const carryHash = (c: EngineCarry | null) => createHash("sha256").update(JSON.stringify(c)).digest("hex");

/** A day's flow file, or null when there is none, it is unreadable or of another format. */
export function readFlowDay(dataDir: string, root: string, date: EtDate): FlowDay | null {
  const p = flowDayPath(dataDir, root, date);
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(gunzipSync(readFileSync(p)).toString("utf8")) as FlowDay;
    return d.format === FLOW_FORMAT ? d : null;
  } catch {
    return null;
  }
}

/**
 * Whether the engine state runs on into `date` from the day before: a weekday whose
 * hours start at its 00:00 ET (the session goes on over midnight), on the same
 * contract as the minute before (roll table). Otherwise the day starts fresh.
 */
export function continuesFromPrevious(day: DayFile, schedule: RollSchedule): boolean {
  const wd = weekday(day.date);
  if (wd === 0 || wd === 6) return false;
  const start = etDayBounds(day.date).start;
  const contract = schedule.dataContractAt(start);
  return day.sessions[0]?.[0] === start && contract !== null && schedule.dataContractAt(start - 1) === contract;
}

/** The state a day starts from: the previous day's end state when the session continues, else none. */
function carryInto(day: DayFile, prev: FlowDay | null, schedule: RollSchedule): EngineCarry | null {
  return prev && prev.date === addDays(day.date, -1) && continuesFromPrevious(day, schedule) ? prev.end : null;
}

/** Whether a day's flow file is current: its format, its source rows, and the state it started from. */
export function flowCurrent(f: FlowDay | null, day: DayFile, prev: FlowDay | null, schedule: RollSchedule): boolean {
  return !!f && f.format === FLOW_FORMAT && sameRef(f.l1, day.l1) && sameRef(f.l2, day.l2) && f.startHash === carryHash(carryInto(day, prev, schedule));
}

/** First index in sorted `ts` (µs) at or after `ms`, from `lo`. */
function seek(ts: Float64Array, ms: number, lo: number): number {
  let i = lo;
  while (i < ts.length && ts[i] / 1000 < ms) i++;
  return i;
}

/**
 * One ET day's flow from its L1 and L2 columns (all rows of the day's row
 * groups, time-sorted), starting from `carry`. Each Globex range of the day is a
 * session stretch: it starts with a reset (unless it continues the carried
 * session at 00:00 ET) and ends with one (unless it runs on past 24:00 ET). L1
 * and L2 rows are merged by time, L1 first on ties.
 */
export function computeFlowDay(day: DayFile, l1: Record<string, Float64Array> | null, l2: Record<string, Float64Array> | null, carry: EngineCarry | null): FlowDay {
  const { start: dayStart, end: dayEnd } = etDayBounds(day.date);
  const book = !!l2 && !!day.l2?.kept;
  const engine = new FlowEngine({ tick: FLOW_TICK, book, carry });
  let q: L1State = carry ? { ...carry.quote } : { ...EMPTY_L1 };
  let i = 0;
  let j = 0;
  day.sessions.forEach(([a, b], r) => {
    if (!(r === 0 && carry && a === dayStart)) {
      engine.reset(a * 1000);
      q = { ...EMPTY_L1 };
    }
    if (l1) i = seek(l1.ts, a, i);
    if (l2) j = seek(l2.ts, a, j);
    const endUs = b * 1000;
    for (;;) {
      const t1 = l1 && i < l1.ts.length && l1.ts[i] < endUs ? l1.ts[i] : Infinity;
      const t2 = l2 && j < l2.ts.length && l2.ts[j] < endUs ? l2.ts[j] : Infinity;
      if (t1 === Infinity && t2 === Infinity) break;
      if (t1 <= t2) {
        const c = l1 as Record<string, Float64Array>;
        const k = c.type[i];
        if (k === L1_TYPE.trade) engine.trade(t1, c.price[i], c.vol[i]);
        else if (k === L1_TYPE.bid || k === L1_TYPE.ask) {
          q = k === L1_TYPE.bid ? { ...q, bid: c.price[i], bidSize: c.vol[i] } : { ...q, ask: c.price[i], askSize: c.vol[i] };
          engine.quoteState(t1, q);
        }
        i++;
      } else {
        const c = l2 as Record<string, Float64Array>;
        const act = c.act[j];
        const side = c.side[j];
        if ((act === 0 || act === 1 || act === 2) && (side === 0 || side === 1)) engine.level(t2, side === 0 ? "bid" : "ask", c.price[j], act === 2 ? 0 : c.vol[j]);
        j++;
      }
    }
    if (b === dayEnd) engine.advance(endUs);
    else engine.reset(endUs);
  });
  const m: FlowColumns = { t: [], bv: [], sv: [], volume: [], trades: [], vwap: [], high: [], low: [], maxPrint: [], sizes: [], ofiQuote: [], imbalance: [], sideless: [], l1Events: [] };
  for (const bkt of [...engine.buckets.values()].sort((x, y) => x.t - y.t)) {
    if (bkt.t < dayStart || bkt.t >= dayEnd) continue;
    const r = recordOf(bkt, true);
    m.t.push(r.t);
    m.bv.push(r.bv);
    m.sv.push(r.sv);
    m.volume.push(r.volume);
    m.trades.push(r.trades);
    m.vwap.push(r.vwap);
    m.high.push(r.high);
    m.low.push(r.low);
    m.maxPrint.push(r.maxPrint);
    m.sizes.push(r.sizes);
    m.ofiQuote.push(r.ofiQuote);
    m.imbalance.push(book ? r.bookImbalance : null);
    m.sideless.push(r.sidelessVolume);
    m.l1Events.push(bkt.l1Events);
  }
  const end = engine.carry();
  return { format: FLOW_FORMAT, root: day.root, date: day.date, l1: refOf(day.l1), l2: refOf(day.l2), book, startHash: carryHash(carry), endHash: carryHash(end), minutes: m, end };
}

/**
 * Build (or keep) the flow files of `days` (one month's day files, any order),
 * oldest first, each from the previous day's end state when the session runs on.
 * A day without L1 has no flow (its file, if any, is removed).
 */
export async function buildFlowDays(o: {
  source: string;
  dataDir: string;
  root: string;
  days: DayFile[];
  schedule: RollSchedule;
  log: (line: string) => void;
}): Promise<{ built: EtDate[]; skipped: EtDate[]; rows: number }> {
  const built: EtDate[] = [];
  const skipped: EtDate[] = [];
  let rows = 0;
  const files = new Map<string, ParquetFile>();
  const open = async (f: string) => {
    let p = files.get(f);
    if (!p) files.set(f, (p = await ParquetFile.open(join(o.source, f))));
    return p;
  };
  for (const day of [...o.days].sort((a, b) => a.date.localeCompare(b.date))) {
    const path = flowDayPath(o.dataDir, o.root, day.date);
    if (!day.l1) {
      if (existsSync(path)) unlinkSync(path);
      continue;
    }
    const prev = readFlowDay(o.dataDir, o.root, addDays(day.date, -1));
    if (flowCurrent(readFlowDay(o.dataDir, o.root, day.date), day, prev, o.schedule)) {
      skipped.push(day.date);
      continue;
    }
    const t0 = performance.now();
    const l1 = await (await open(day.l1.file)).read(day.l1.rowGroup, L1_COLUMNS);
    const l2 = day.l2 ? await (await open(day.l2.file)).read(day.l2.rowGroup, L2_COLUMNS) : null;
    rows += l1.ts.length + (l2?.ts.length ?? 0);
    const flow = computeFlowDay(day, l1, l2, carryInto(day, prev, o.schedule));
    writeAtomic(path, gzipSync(JSON.stringify(flow)));
    built.push(day.date);
    o.log(`${day.date} flow: ${flow.minutes.t.length} minutes${flow.book ? "" : " (no L2: imbalance null)"}, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  return { built, skipped, rows };
}

/** The manifest's flow section: the days (of `days`, current day files) whose flow file is current, chained from the day before. */
export function flowSummary(dataDir: string, root: string, days: DayFile[], schedule: RollSchedule): FlowSummary {
  const ok: EtDate[] = [];
  let prev: FlowDay | null = null;
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const f = readFlowDay(dataDir, root, day.date);
    const before = prev && prev.date === addDays(day.date, -1) ? prev : readFlowDay(dataDir, root, addDays(day.date, -1));
    if (f && flowCurrent(f, day, before, schedule) && (!carryInto(day, before, schedule) || ok.includes(addDays(day.date, -1)))) ok.push(day.date);
    prev = f;
  }
  return { format: FLOW_FORMAT, tick: FLOW_TICK, levels: BOOK_LEVELS, l1Grouping: L1_STATE_GROUPING, days: ok };
}

/**
 * The minute records of contract `code` for minutes [from, to] (UTC ms) as of
 * `cutoff`, from the flow files (`read` caches them). A minute is complete only
 * when: it ended by the cutoff (nothing at or after the cutoff is read: a later
 * or partial minute is an empty, incomplete record), its day's flow is current,
 * it has L1 data, the roll table puts the data on `code` then and no exception
 * stretch covers it, and its prints are all sided. Minutes with no row are
 * absent (incomplete for bar flow).
 */
export function flowRecords(
  read: (date: EtDate) => FlowDay | null,
  summary: FlowSummary,
  schedule: RollSchedule,
  code: string,
  from: number,
  to: number,
  cutoff: number,
): { byMinute: Map<number, MinuteRecord>; missingDays: EtDate[] } {
  const byMinute = new Map<number, MinuteRecord>();
  const missingDays: EtDate[] = [];
  const days = new Set(summary.days);
  const last = Math.min(to, cutoff - MINUTE_MS);
  for (let d = etDate(from); etDayBounds(d).start <= to; d = addDays(d, 1)) {
    const { start, end } = etDayBounds(d);
    const f = days.has(d) ? read(d) : null;
    if (!f) {
      // A day the market trades (Globex hours) up to the clock, without current flow: listed.
      if (start <= last && globexRanges(d).length) missingDays.push(d);
      continue;
    }
    const m = f.minutes;
    for (let k = 0; k < m.t.length; k++) {
      const t = m.t[k];
      if (t < from || t > to || t < start || t >= end) continue;
      if (t > last) {
        byMinute.set(t, recordOf(newBucket(t), false));
        continue;
      }
      const covered = m.l1Events[k] > 0 && m.sideless[k] === 0 && schedule.dataContractAt(t) === code && !schedule.inException(t);
      byMinute.set(t, {
        t,
        bv: m.bv[k],
        sv: m.sv[k],
        volume: m.volume[k],
        trades: m.trades[k],
        vwap: m.vwap[k],
        high: m.high[k],
        low: m.low[k],
        maxPrint: m.maxPrint[k],
        sizes: m.sizes[k],
        // Volume at price (the footprint's) isn't stored: no tool here serves a footprint yet.
        vap: [],
        ofiQuote: m.ofiQuote[k],
        bookImbalance: m.imbalance[k],
        badTimestamps: 0,
        sidelessVolume: m.sideless[k],
        complete: covered,
        source: "history",
      });
    }
  }
  return { byMinute, missingDays };
}

