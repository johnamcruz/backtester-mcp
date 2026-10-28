import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { BarSeries, MINUTE } from "./bars.js";
import { etDate, etDayBounds, sessionsOf, type EtDate } from "./calendar.js";
import { EMPTY_QUOTE, normalizeL1, normalizeL2, type DepthEvent, type MinuteBars, type QuoteEvent, type QuoteState, type TradeEvent } from "./events.js";
import { ParquetFile } from "./parquet.js";
import { FLOW_FORMAT, flowRecords, readFlowDay, type FlowDay, type FlowSummary } from "./flowstore.js";
import { quarantineHashOf, type Conflict, type MinuteRun, type Outside, type Quarantined } from "./dayassign.js";
import type { MinuteRecord } from "./orderflow.js";
import { scheduleOf, type RollSchedule, type RollTable } from "./rolltable.js";

/**
 * The precomputed store: raw one-minute bars of the local NQ order-book data
 * (built from L1 trades by `build-store`), per ET day, with an index into the
 * source parquet for the day's events. Layout, under BACKTESTER_DATA_DIR:
 *
 *   derived/<ROOT>/manifest.json          what was built: months, days, gaps, the roll table, contracts
 *   derived/<ROOT>/days/YYYY-MM-DD.json.gz one ET day: its bars, event index, quote states
 *   derived/<ROOT>/flow/YYYY-MM-DD.json.gz one ET day's order flow per minute (flowstore.ts)
 *   derived/<ROOT>/assign/YYYYMM.json      one month's day assignment report (dayassign.ts), for the manifest
 *
 * Which contract a bar belongs to comes only from the reviewed roll table
 * (rolltable.ts), applied to each minute.
 *
 * Only NQ has order-book data; MNQ reads NQ's (MNQ tracks NQ).
 */

export const STORE_FORMAT = 2;
export const L1_COLUMNS = ["ts", "type", "price", "vol"];
export const L2_COLUMNS = ["ts", "side", "price", "vol", "depth", "act"];

/** Where one day's rows sit in the source, and its minute index ([minute open ms, first row]). */
export interface SourceRef {
  /** Relative to the source folder, e.g. "l1/202403.parquet". */
  file: string;
  /** The parquet file's size and modification time, so a changed source is rebuilt. */
  size: number;
  mtime: number;
  rowGroup: number;
  rows: number;
  /** Rows inside the day's Globex hours (the rest are dropped: out of the ET day, weekend, daily break). */
  kept: number;
  index: Array<[number, number]>;
}

export interface DayFile {
  format: number;
  root: string;
  date: EtDate;
  /** The roll table's contract at the day's 00:00 ET (null: none), e.g. "M24". */
  contract: string | null;
  /** Globex hours of the day, UTC ms; rows outside them are dropped. */
  sessions: Array<[number, number]>;
  l1: (SourceRef & { trades: number }) | null;
  l2: SourceRef | null;
  /** The best-quote state at the day's first kept row (carried over midnight within a session) and after its last. */
  quoteStart: QuoteState;
  quoteEnd: QuoteState;
  bars: MinuteBars;
}

export interface DaySummary {
  contract: string | null;
  l1Rows: number;
  l1Kept: number;
  trades: number;
  bars: number;
  l2Rows: number | null;
  l2Kept: number | null;
}

export interface Manifest {
  format: number;
  root: string;
  /** The source folder (l1/ and l2/ monthly parquet) the store was built from. */
  source: string;
  /** Months (YYYYMM) whose L1 file was read; the store covers their ET days. */
  months: string[];
  /** Months asked for with no L1 file. */
  missingMonths: string[];
  days: Record<EtDate, DaySummary>;
  /**
   * Weekdays of built months without L1 trades / without L2 rows (full holidays listed apart), and
   * `minutes`: runs of the minutes the market was expected to trade (calendar.ts#expectedRanges: Globex
   * hours and the reviewed CME holiday calendar) without a single L1 row, oldest first.
   */
  gaps: { l1: EtDate[]; l2: EtDate[]; holidays: EtDate[]; minutes: MinuteRun[] };
  /**
   * How source row groups were assigned to ET days (dayassign.ts): every date two row groups had rows on
   * (the one kept, the others' rows there left out), every row group with more than 1% of its rows outside
   * its own day, the quarantined row groups left out (quarantine-nq.ts, with its hash), and built months
   * without an assignment report (built before reports existed: rebuild them).
   */
  assignment: { conflicts: Conflict[]; outside: Outside[]; quarantined: Quarantined[]; quarantineHash: string; unchecked: string[] };
  /** The roll table the bars are assigned by, with its hash (runs pin it). */
  rollTable: RollTable & { hash: string };
  /** Day files left out: unreadable, or built from a source file that has changed or is gone since. */
  dropped: Array<{ date: EtDate; reason: string }>;
  /** Per contract code: its first and last bar, bar count and the days holding them. */
  contracts: Record<string, { first: string; last: string; bars: number; days: EtDate[] }>;
  /** The order flow built (flowstore.ts): its format and the days whose flow is current. Absent: none built. */
  flow?: FlowSummary;
}

export const storeDir = (dataDir: string, root: string) => join(dataDir, "derived", root);
export const manifestPath = (dataDir: string, root: string) => join(storeDir(dataDir, root), "manifest.json");
export const dayPath = (dataDir: string, root: string, date: EtDate) => join(storeDir(dataDir, root), "days", `${date}.json.gz`);
export const assignPath = (dataDir: string, root: string, month: string) => join(storeDir(dataDir, root), "assign", `${month}.json`);
/** Present while build-store rewrites the store (written first, removed after the new manifest): the store isn't used then. */
export const buildingPath = (dataDir: string, root: string) => join(storeDir(dataDir, root), "building.json");

/** How to rebuild a refused store. */
export const REBUILD_HINT =
  "Rebuild it over all its months: npm run build-store -- --from <first YYYYMM> --to <last YYYYMM> (unchanged days are skipped); or set BACKTESTER_STORE=off to use the CSV series on purpose.";

/** Write via a temp file and rename, so a reader never sees half a file. */
export function writeAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function writeDay(dataDir: string, day: DayFile): void {
  writeAtomic(dayPath(dataDir, day.root, day.date), gzipSync(JSON.stringify(day)));
}

/** A day file, or null when there is none or it is of another format. Throws when it is unreadable (truncated). */
export function readDay(dataDir: string, root: string, date: EtDate): DayFile | null {
  const p = dayPath(dataDir, root, date);
  if (!existsSync(p)) return null;
  let d: DayFile;
  try {
    d = JSON.parse(gunzipSync(readFileSync(p)).toString("utf8")) as DayFile;
  } catch (e) {
    throw new Error(`unreadable store day file ${p}: ${(e as Error).message}`);
  }
  return d.format === STORE_FORMAT ? d : null;
}

/** Dates of the day files present, oldest first. */
export function listDays(dataDir: string, root: string): EtDate[] {
  const dir = join(storeDir(dataDir, root), "days");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d\d-\d\d\.json\.gz$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

export function readManifest(dataDir: string, root: string): Manifest | null {
  const p = manifestPath(dataDir, root);
  if (!existsSync(p)) return null;
  const m = JSON.parse(readFileSync(p, "utf8")) as Manifest;
  return m.format === STORE_FORMAT ? m : null;
}

/** The data's contract for each bar of a day, from the roll table (null: no contract). */
export function barContracts(day: DayFile, schedule: RollSchedule): Array<string | null> {
  return day.bars.t.map((t) => schedule.dataContractAt(t));
}

/**
 * A day of the store without order-book data (the manifest's gaps.l1: no trade, no day file) served from the root's
 * price CSV instead: the front contract's minutes of that day (roll table), the CSV's back-adjusted prices less the
 * contract's constant adjustment (the CSV's close minus the raw close, the same on every day the data is on the
 * contract: measured on the nearest store days of the contract before and after), volume as is, no order flow.
 */
export interface PriceFallback {
  date: EtDate;
  code: string;
  /** CSV minus raw, in price; subtracted from the CSV's OHLC. */
  offset: number;
  /** The neighbouring store days it was measured on, each with its offset and the share of matched minutes at it. */
  measured: Array<{ date: EtDate; offset: number; share: number; minutes: number }>;
  /** Indices into the CSV series of the day's served minutes. */
  from: number;
  to: number;
  minutes: number[];
}

/** One gap day as get_server_config.dataGaps lists it: bars from the price CSV (bars: true) or none at all. */
export interface DataGap {
  day: EtDate;
  bars: boolean;
  flow: false;
}

export interface DayEvents {
  trades: TradeEvent[];
  quotes: QuoteEvent[];
  depth: DepthEvent[];
}

/**
 * Reads the derived store of BACKTESTER_DATA_DIR (once per process, like the
 * CSV files): which contracts the clock sees, a contract's raw bars, and a
 * day's normalized events from the source parquet.
 */
export class DerivedStore {
  private readonly manifests = new Map<string, Manifest | null>();
  private readonly refusals = new Map<string, string | null>();
  private readonly hashes = new Map<string, string | null>();
  private readonly series = new Map<string, BarSeries>();
  private readonly flowDays = new Map<string, FlowDay | null>();
  private readonly fallbacks = new Map<string, PriceFallback[]>();

  constructor(
    private readonly dataDir: string,
    /** Overrides the manifest's source folder for event reads (BACKTESTER_ORDERBOOK_DIR). */
    private readonly sourceDir: string | null = null,
    /** The root's price CSV (back-adjusted, continuous), for the store's days without order-book data; null: none. */
    private readonly prices: ((root: string) => BarSeries | null) | null = null,
  ) {}

  /**
   * The store's days without order-book data that the price CSV serves (PriceFallback), oldest first. A gap day the
   * CSV has no minute of in the day's Globex hours, or whose contract has no store day to measure its adjustment on,
   * is left out: it has no bars at all.
   */
  priceFallbacks(root: string): PriceFallback[] {
    const cached = this.fallbacks.get(root);
    if (cached) return cached;
    const m = this.manifest(root);
    const schedule = scheduleOf(root);
    const csv = m && schedule && m.gaps.l1.length ? this.prices?.(root) ?? null : null;
    const out: PriceFallback[] = [];
    if (m && schedule && csv) {
      for (const date of m.gaps.l1) {
        if (m.days[date]?.bars) continue;
        const { start, end } = etDayBounds(date);
        const sessions = sessionsOf(date);
        const byCode = new Map<string, number[]>();
        for (let i = csv.lowerBound(start); i < csv.length && csv.t[i] < end; i++) {
          const t = csv.t[i];
          if (!sessions.some(([a, b]) => t >= a && t < b)) continue;
          const code = schedule.dataContractAt(t);
          if (code === null) continue;
          (byCode.get(code) ?? byCode.set(code, []).get(code)!).push(i);
        }
        for (const [code, minutes] of byCode) {
          const days = m.contracts[code]?.days ?? [];
          const before = [...days].reverse().find((d) => d < date);
          const after = days.find((d) => d > date);
          const measured = [before, after].filter((d): d is EtDate => !!d).map((d) => ({ date: d, ...this.adjustment(root, code, d, csv, schedule) })).filter((x) => x.minutes > 0);
          if (!measured.length) continue;
          out.push({ date, code, offset: measured[0].offset, measured, from: minutes[0], to: minutes[minutes.length - 1] + 1, minutes });
        }
      }
    }
    this.fallbacks.set(root, out);
    return out;
  }

  /** The CSV's close minus the store's on a store day's minutes of `code`: the most common difference (ticks), its share. */
  private adjustment(root: string, code: string, date: EtDate, csv: BarSeries, schedule: RollSchedule): { offset: number; share: number; minutes: number } {
    const day = readDay(this.dataDir, root, date);
    const counts = new Map<number, number>();
    let n = 0;
    if (day) {
      const owner = barContracts(day, schedule);
      for (let i = 0; i < day.bars.t.length; i++) {
        if (owner[i] !== code) continue;
        const k = csv.lowerBound(day.bars.t[i]);
        if (k >= csv.length || csv.t[k] !== day.bars.t[i]) continue;
        const d = Math.round((csv.c[k] - day.bars.c[i]) * 4) / 4;
        counts.set(d, (counts.get(d) ?? 0) + 1);
        n++;
      }
    }
    const [offset, hits] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [0, 0];
    return { offset, share: n ? Math.round((hits / n) * 1000) / 1000 : 0, minutes: n };
  }

  /** The store's gap days (gaps.l1): each with whether the price CSV serves its bars; none has order flow. */
  dataGaps(root: string): DataGap[] {
    const m = this.manifest(root);
    if (!m) return [];
    const served = new Set(this.priceFallbacks(root).map((f) => f.date));
    return m.gaps.l1.map((day) => ({ day, bars: served.has(day), flow: false as const }));
  }

  /**
   * The root's manifest, read once; null when there is no store, or when the store
   * is refused (`refusal` says why): a build is running or was interrupted, it is
   * of another store format, built with another roll table (its contract
   * index would be wrong) or another quarantine table (it could serve mistimed
   * rows), or some of its months weren't assigned by the current day assignment.
   */
  manifest(root: string): Manifest | null {
    if (!this.manifests.has(root)) {
      const p = manifestPath(this.dataDir, root);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;
      let m: Manifest | null = null;
      let refused: string | null = null;
      try {
        m = text === null ? null : (JSON.parse(text) as Manifest);
      } catch {
        refused = "manifest unreadable";
      }
      const schedule = scheduleOf(root);
      if (existsSync(buildingPath(this.dataDir, root))) refused = "a build-store run is in progress or was interrupted";
      else if (!m) {
        // No store, or an unreadable manifest (refused above).
      } else if (m.format !== STORE_FORMAT) refused = `store format ${m.format}, not ${STORE_FORMAT}`;
      else if (!schedule || m.rollTable?.hash !== schedule.hash) refused = "built with another roll table";
      else if (!m.assignment) refused = "built before day assignment (no assignment in manifest)";
      else if (m.assignment.quarantineHash !== quarantineHashOf(root)) refused = "built with another quarantine table";
      else if (m.assignment.unchecked.length) refused = `months ${m.assignment.unchecked.join(", ")} not assigned by the current day assignment`;
      if (refused) {
        process.stderr.write(`[backtester-mcp] the derived store ${storeDir(this.dataDir, root)} is not used: ${refused}. ${REBUILD_HINT}\n`);
        m = null;
      }
      this.refusals.set(root, refused);
      this.manifests.set(root, m);
      this.hashes.set(root, m && text ? createHash("sha256").update(text).digest("hex") : null);
    }
    return this.manifests.get(root) ?? null;
  }

  /** Why the root's store exists but isn't used, or null (no store, or a usable one). */
  refusal(root: string): string | null {
    this.manifest(root);
    return this.refusals.get(root) ?? null;
  }

  /** The sha256 of the root's manifest file as read (runs pin it), or null without a usable one. */
  manifestHash(root: string): string | null {
    this.manifest(root);
    return this.hashes.get(root) ?? null;
  }

  /** Whether the store covers `ms` for `root`: it falls on an ET day of a built month, inside the roll table. */
  covers(root: string, ms: number): boolean {
    const m = this.manifest(root);
    return !!m && m.months.includes(etDate(ms).slice(0, 7).replace("-", "")) && !!scheduleOf(root)?.covers(ms);
  }

  /** The front (active) contract code at `ms` when the store covers it (roll table), else null. */
  frontAt(root: string, ms: number): string | null {
    return this.covers(root, ms) ? (scheduleOf(root)?.activeAt(ms) ?? null) : null;
  }

  /** Moments in (from, to] when the root's data leaves a contract (roll table). */
  switchesBetween(root: string, from: number, to: number): Array<{ at: number; off: string }> {
    return this.manifest(root) ? (scheduleOf(root)?.switchesBetween(from, to) ?? []) : [];
  }

  has(root: string, code: string): boolean {
    return !!this.manifest(root)?.contracts[code];
  }

  /** A contract's raw one-minute bars: every built minute the data has on it, oldest first. */
  bars(root: string, code: string): BarSeries {
    const key = `${root}.${code}`;
    let s = this.series.get(key);
    if (s) return s;
    const m = this.manifest(root);
    const entry = m?.contracts[code];
    if (!m || !entry) throw new Error(`no stored bars for ${root} ${code}`);
    const cols: number[][] = [[], [], [], [], [], []];
    const push = (t: number, o: number, h: number, l: number, c: number, v: number) => {
      cols[0].push(t);
      cols[1].push(o);
      cols[2].push(h);
      cols[3].push(l);
      cols[4].push(c);
      cols[5].push(v);
    };
    // The days without order-book data the price CSV serves for this contract, merged in date order.
    const fills = this.priceFallbacks(root).filter((f) => f.code === code);
    const csv = fills.length ? this.prices?.(root) ?? null : null;
    const fill = (f: PriceFallback) => {
      for (const i of f.minutes) push(csv!.t[i], csv!.o[i] - f.offset, csv!.h[i] - f.offset, csv!.l[i] - f.offset, csv!.c[i] - f.offset, csv!.v[i]);
    };
    let fi = 0;
    for (const date of entry.days) {
      while (fi < fills.length && fills[fi].date < date) fill(fills[fi++]);
      const day = readDay(this.dataDir, root, date);
      if (!day) throw new Error(`store day file ${date} of ${root} is missing or of another format: rebuild with build-store`);
      const owner = barContracts(day, scheduleOf(root) as RollSchedule);
      const b = day.bars;
      for (let i = 0; i < b.t.length; i++) {
        if (owner[i] !== code) continue;
        push(b.t[i], b.o[i], b.h[i], b.l[i], b.c[i], b.v[i]);
      }
    }
    while (fi < fills.length) fill(fills[fi++]);
    const [t, o, h, l, c, v] = cols.map((x) => Float64Array.from(x));
    s = new BarSeries(t, o, h, l, c, v);
    this.series.set(key, s);
    return s;
  }

  /**
   * A contract month's bars as live's history shows them (get_bars): live, every listed expiry trades at once, so
   * the new front's bars reach back before it became the front (its back-month trading). The local data holds the
   * front only, so before the data's switch to `code` (its roll in the table) its history is the previous
   * contract's bars shifted by the spread at the switch: `code`'s first bar's open minus the previous contract's
   * last close before it (adjacent minutes: every switch is at 00:00 ET, inside the overnight session). Minutes
   * where `code` has bars of its own before the switch (an exception stretch) keep them. One contract back: about
   * a quarter of history before the roll. Until `code`'s first bar after the switch is closed at `cutoff` the
   * spread isn't known, and only its own bars are served (no bar is made up from a later price). The prices are
   * tick multiples (a difference of two); the volume is the previous contract's (the front's activity). Fills,
   * quotes and settlement never read this: they use `bars` (only the contract's own data).
   */
  history(root: string, code: string, cutoff: number): BarSeries {
    const own = this.bars(root, code);
    const roll = scheduleOf(root)?.table.rolls.find((r) => r.to === code);
    if (!roll || !this.has(root, roll.from)) return own;
    const at = Date.parse(roll.at);
    const k = own.lowerBound(at);
    if (k >= own.length || own.t[k] + MINUTE > cutoff) return own;
    const key = `${root}.${code}.history`;
    const cached = this.series.get(key);
    if (cached) return cached;
    const prev = this.bars(root, roll.from);
    const j = prev.lowerBound(at) - 1;
    if (j < 0) return own;
    const spread = own.o[k] - prev.c[j];
    const cols: number[][] = [[], [], [], [], [], []];
    const push = (s: BarSeries, i: number, d: number) => {
      cols[0].push(s.t[i]);
      cols[1].push(s.o[i] + d);
      cols[2].push(s.h[i] + d);
      cols[3].push(s.l[i] + d);
      cols[4].push(s.c[i] + d);
      cols[5].push(s.v[i]);
    };
    // Merge, oldest first: the previous contract's minutes before the switch (shifted), and every own bar, which
    // wins a minute both have.
    let a = 0;
    for (let i = 0; i < own.length; i++) {
      while (a <= j && prev.t[a] < own.t[i]) push(prev, a++, spread);
      if (a <= j && prev.t[a] === own.t[i]) a++;
      push(own, i, 0);
    }
    while (a <= j) push(prev, a++, spread);
    const [t, o, h, l, c, v] = cols.map((x) => Float64Array.from(x));
    const s = new BarSeries(t, o, h, l, c, v);
    this.series.set(key, s);
    return s;
  }

  /**
   * The order-flow minute records of contract month `code` of `root` for minutes
   * [from, to] as of `cutoff` (flowstore.ts#flowRecords: nothing at or after the
   * cutoff is used). Null when the store has no current flow.
   */
  flowRecords(root: string, code: string, from: number, to: number, cutoff: number): { byMinute: Map<number, MinuteRecord>; missingDays: EtDate[] } | null {
    const m = this.manifest(root);
    const schedule = scheduleOf(root);
    if (m?.flow?.format !== FLOW_FORMAT || !schedule) return null;
    const read = (date: EtDate) => {
      const key = `${root}.${date}`;
      if (!this.flowDays.has(key)) this.flowDays.set(key, readFlowDay(this.dataDir, root, date));
      return this.flowDays.get(key) ?? null;
    };
    return flowRecords(read, m.flow, schedule, code, from, to, cutoff);
  }

  /**
   * One ET day's normalized events in [from, to) (UTC ms, default the whole
   * day), read from the source parquet: trades and quote states from L1
   * (the quote state replayed from the day's start), L2 changes through the
   * minute index. Rows outside the day's Globex hours are left out. It reads
   * whatever range it is asked for: a caller serving the model must clamp `to`
   * at the replay cutoff, and should cache decoded days. (get_bars' order flow
   * doesn't read events at call time: it is computed at build time, flowstore.ts.)
   */
  async events(root: string, date: EtDate, opts: { from?: number; to?: number; l2?: boolean } = {}): Promise<DayEvents> {
    const m = this.manifest(root);
    const day = readDay(this.dataDir, root, date);
    if (!m || !day) throw new Error(`no stored day ${date} for ${root}`);
    const src = this.sourceDir ?? m.source;
    const from = opts.from ?? -Infinity;
    const to = opts.to ?? Infinity;
    const inRange = (tUs: number) => tUs / 1000 >= from && tUs / 1000 < to;
    const out: DayEvents = { trades: [], quotes: [], depth: [] };
    if (day.l1) {
      const f = await ParquetFile.open(join(src, day.l1.file));
      const cols = await f.read(day.l1.rowGroup, L1_COLUMNS, 0, Number.isFinite(to) ? rowAt(day.l1.index, Math.ceil(to / 60000) * 60000, day.l1.rows) : day.l1.rows);
      const l1 = normalizeL1(cols, day.sessions, day.quoteStart ?? EMPTY_QUOTE);
      out.trades = l1.trades.filter((e) => inRange(e.t));
      out.quotes = l1.quotes.filter((e) => inRange(e.t));
    }
    if (day.l2 && opts.l2 !== false) {
      const f = await ParquetFile.open(join(src, day.l2.file));
      const a = Number.isFinite(from) ? rowAt(day.l2.index, Math.floor(from / 60000) * 60000, day.l2.rows) : 0;
      const b = Number.isFinite(to) ? rowAt(day.l2.index, Math.ceil(to / 60000) * 60000, day.l2.rows) : day.l2.rows;
      const cols = await f.read(day.l2.rowGroup, L2_COLUMNS, a, b);
      out.depth = normalizeL2(cols, day.sessions).filter((e) => inRange(e.t));
    }
    return out;
  }
}

/** The first row of the first indexed minute at or after `minute` (ms), or `total` when none is. */
export function rowAt(index: Array<[number, number]>, minute: number, total: number): number {
  for (const [t, row] of index) if (t >= minute) return row;
  return total;
}
