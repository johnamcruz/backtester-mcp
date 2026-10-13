import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { addDays, etDate, etDayBounds, globexRanges, isFullHoliday, weekday, type EtDate } from "./calendar.js";
import { EMPTY_QUOTE, keepRow, minuteBars, minuteIndex, normalizeL1, type QuoteState } from "./events.js";
import { ParquetFile } from "./parquet.js";
import { scheduleOf, type RollSchedule } from "./rolltable.js";
import {
  L1_COLUMNS,
  STORE_FORMAT,
  barContracts,
  dayPath,
  listDays,
  manifestPath,
  readDay,
  readManifest,
  storeDir,
  writeAtomic,
  writeDay,
  type DayFile,
  type Manifest,
  type SourceRef,
} from "./store.js";

/**
 * Building the precomputed store from the local order-book parquet (see
 * store.ts for the layout). Months in order, one ET day (one row group) at a
 * time; a day whose file already matches its source (file, size, mtime, row
 * group, rows) and the quote state carried into it is skipped, so a build can
 * be stopped and resumed, and running it twice changes nothing. One build at a
 * time per store (a lock file). After the days, the manifest is recomputed
 * from every day file still matching its source: gaps and contracts, by the
 * reviewed roll table.
 */

export interface BuildOptions {
  /** The folder holding l1/YYYYMM.parquet and l2/YYYYMM.parquet (read only). */
  source: string;
  /** BACKTESTER_DATA_DIR: the store goes to <dataDir>/derived/<root>/. */
  dataDir: string;
  /** First and last month, YYYYMM. */
  from: string;
  to: string;
  root?: string;
  /** Progress lines (stderr in the CLI). */
  log?: (line: string) => void;
}

export interface BuildSummary {
  months: string[];
  missingMonths: string[];
  built: EtDate[];
  skipped: EtDate[];
  rows: number;
  seconds: number;
  manifest: Manifest;
}

/** YYYYMM months from `from` to `to`, inclusive. */
export function monthRange(from: string, to: string): string[] {
  const ok = (s: string) => /^\d{6}$/.test(s) && Number(s.slice(4)) >= 1 && Number(s.slice(4)) <= 12;
  if (!ok(from) || !ok(to)) throw new Error(`months are YYYYMM, got "${from}" and "${to}"`);
  if (to < from) throw new Error(`--to ${to} is before --from ${from}`);
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(4));
  for (let s = from; s <= to; ) {
    out.push(s);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
    s = `${y}${String(m).padStart(2, "0")}`;
  }
  return out;
}

const inside = (dir: string, path: string) => {
  const r = relative(resolve(dir), resolve(path));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** The ET date a row group belongs to: that of its middle row (robust to stray rows at either end). */
export const dateOfRows = (ts: Float64Array) => etDate(Math.floor(ts[ts.length >> 1] / 1000));

type FileStamp = { size: number; mtime: number };
const stampOf = (path: string): FileStamp | null => {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  return { size: st.size, mtime: Math.floor(st.mtimeMs) };
};

const sameRef = (a: SourceRef | null | undefined, file: string, stamp: FileStamp, rowGroup: number, rows: number) =>
  !!a && a.file === file && a.size === stamp.size && a.mtime === stamp.mtime && a.rowGroup === rowGroup && a.rows === rows;

const sameL2 = (a: SourceRef | null, b: SourceRef | undefined) =>
  a === null ? b === undefined : !!b && a.file === b.file && a.size === b.size && a.mtime === b.mtime && a.rowGroup === b.rowGroup && a.rows === b.rows;

const sameQuote = (a: QuoteState, b: QuoteState) => a.bid === b.bid && a.bidSize === b.bidSize && a.ask === b.ask && a.askSize === b.askSize;

/** Take the store's build lock, or say who holds it. */
function lockStore(dir: string): () => void {
  const path = join(dir, "build.lock");
  mkdirSync(dir, { recursive: true });
  try {
    const fd = openSync(path, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    throw new Error(`another build-store is running on ${dir} (lock ${path}); if none is, delete the lock`);
  }
  return () => {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
}

export async function buildStore(o: BuildOptions): Promise<BuildSummary> {
  const root = o.root ?? "NQ";
  const log = o.log ?? (() => {});
  const schedule = scheduleOf(root);
  if (!schedule) throw new Error(`no roll table for ${root}: only NQ's data has one`);
  const source = resolve(o.source);
  const out = storeDir(o.dataDir, root);
  if (!existsSync(join(source, "l1"))) throw new Error(`no l1/ folder in ${source}: --source is the folder holding l1/ and l2/`);
  if (inside(source, out)) throw new Error(`the store (${out}) must not be inside the source folder ${source}, which is read only`);
  const months = monthRange(o.from, o.to);
  const unlock = lockStore(out);
  try {
    return await build(o, root, source, months, schedule, log);
  } finally {
    unlock();
  }
}

async function build(o: BuildOptions, root: string, source: string, months: string[], schedule: RollSchedule, log: (s: string) => void): Promise<BuildSummary> {
  const t0 = performance.now();
  let rows = 0;
  const built: EtDate[] = [];
  const skipped: EtDate[] = [];
  const missingMonths: string[] = [];
  const existing = new Map<EtDate, DayFile>();
  for (const d of listDays(o.dataDir, root)) {
    try {
      const day = readDay(o.dataDir, root, d);
      if (day) existing.set(d, day);
    } catch (e) {
      log(`${(e as Error).message}; that day is rebuilt`);
    }
  }
  const doneMonths: string[] = [];

  for (const month of months) {
    const l1Name = `l1/${month}.parquet`;
    const l2Name = `l2/${month}.parquet`;
    const l1Stamp = stampOf(join(source, l1Name));
    if (!l1Stamp) {
      missingMonths.push(month);
      log(`${month}: no ${l1Name}, skipped`);
      continue;
    }
    const l2Stamp = stampOf(join(source, l2Name));
    const l1 = await ParquetFile.open(join(source, l1Name));
    const l2 = l2Stamp ? await ParquetFile.open(join(source, l2Name)) : null;
    const days = [...existing.values()];
    const doneL1 = (rg: number, n: number) => days.find((d) => sameRef(d.l1, l1Name, l1Stamp, rg, n));
    const doneL2 = (rg: number, n: number) => (l2Stamp ? days.find((d) => sameRef(d.l2, l2Name, l2Stamp, rg, n)) : undefined);

    // L2: only the timestamps, for each day's minute index and kept count.
    const l2Days = new Map<EtDate, SourceRef>();
    for (const g of l2?.rowGroups ?? []) {
      const prior = doneL2(g.index, g.rows);
      if (prior?.l2) {
        l2Days.set(prior.date, prior.l2);
        continue;
      }
      if (!g.rows) continue;
      const { ts } = await (l2 as ParquetFile).read(g.index, ["ts"]);
      rows += g.rows;
      const date = dateOfRows(ts);
      if (l2Days.has(date)) log(`${month}: L2 row group ${g.index} repeats ${date}; the first one is kept`);
      else l2Days.set(date, { file: l2Name, ...(l2Stamp as FileStamp), rowGroup: g.index, rows: g.rows, kept: countKept(ts, globexRanges(date)), index: minuteIndex(ts) });
    }

    const seen = new Set<EtDate>();
    for (const g of l1.rowGroups) {
      const prior = doneL1(g.index, g.rows);
      if (prior && sameL2(prior.l2, l2Days.get(prior.date)) && sameQuote(prior.quoteStart, carriedQuote(existing, prior.date, schedule))) {
        seen.add(prior.date);
        skipped.push(prior.date);
        continue;
      }
      if (!g.rows) continue;
      const t1 = performance.now();
      const cols = await l1.read(g.index, L1_COLUMNS);
      rows += g.rows;
      const date = dateOfRows(cols.ts);
      if (seen.has(date)) {
        log(`${month}: L1 row group ${g.index} repeats ${date}; the first one is kept`);
        continue;
      }
      seen.add(date);
      const sessions = globexRanges(date);
      const quoteStart = carriedQuote(existing, date, schedule);
      const n = normalizeL1(cols, sessions, quoteStart, { quotes: false });
      const day: DayFile = {
        format: STORE_FORMAT,
        root,
        date,
        contract: schedule.dataContractAt(etDayBounds(date).start),
        sessions,
        l1: { file: l1Name, ...l1Stamp, rowGroup: g.index, rows: g.rows, kept: n.kept, trades: n.trades.length, index: minuteIndex(cols.ts) },
        l2: l2Days.get(date) ?? null,
        quoteStart,
        quoteEnd: { ...n.end },
        bars: minuteBars(n.trades),
      };
      writeDay(o.dataDir, day);
      existing.set(date, day);
      built.push(date);
      const s = (performance.now() - t1) / 1000;
      log(
        `${date} ${root}${day.contract ?? "-"}: L1 ${g.rows} rows (${n.kept} kept, ${n.trades.length} trades, ${day.bars.t.length} bars)` +
          `, L2 ${day.l2 ? `${day.l2.rows} rows` : "none"}, ${s.toFixed(1)} s`,
      );
    }
    // L2 days with no L1 row group still get a day file (no bars).
    for (const [date, ref] of l2Days) {
      if (seen.has(date)) continue;
      const prior = existing.get(date);
      if (prior && !prior.l1 && sameL2(prior.l2, ref)) {
        skipped.push(date);
        continue;
      }
      const day: DayFile = {
        format: STORE_FORMAT,
        root,
        date,
        contract: schedule.dataContractAt(etDayBounds(date).start),
        sessions: globexRanges(date),
        l1: null,
        l2: ref,
        quoteStart: { ...EMPTY_QUOTE },
        quoteEnd: { ...EMPTY_QUOTE },
        bars: { t: [], o: [], h: [], l: [], c: [], v: [] },
      };
      writeDay(o.dataDir, day);
      existing.set(date, day);
      built.push(date);
    }
    doneMonths.push(month);
  }

  const prev = (() => {
    try {
      return readManifest(o.dataDir, root);
    } catch {
      return null;
    }
  })();
  const allMonths = [...new Set([...(prev?.months ?? []), ...doneMonths])].sort();
  const stillMissing = [...new Set([...(prev?.missingMonths ?? []), ...missingMonths])].filter((m) => !allMonths.includes(m)).sort();
  const manifest = buildManifest(o.dataDir, root, source, allMonths, stillMissing, schedule, log);
  writeAtomic(manifestPath(o.dataDir, root), JSON.stringify(manifest, null, 1));
  const seconds = (performance.now() - t0) / 1000;
  log(
    `done: ${built.length} days built, ${skipped.length} up to date, ${rows} rows read in ${seconds.toFixed(1)} s` +
      (seconds > 0 && rows ? ` (${Math.round(rows / seconds)} rows/s)` : "") +
      `; gaps L1 ${manifest.gaps.l1.length}, L2 ${manifest.gaps.l2.length}; ${manifest.dropped.length} day files left out`,
  );
  return { months: doneMonths, missingMonths, built, skipped, rows, seconds, manifest };
}

function countKept(ts: Float64Array, ranges: Array<[number, number]>): number {
  let n = 0;
  for (let i = 0; i < ts.length; i++) if (keepRow(ts[i], ranges)) n++;
  return n;
}

/**
 * The quote state a day starts with: the previous ET day's end state when the
 * session runs on over midnight into this day (Monday to Friday) on the same
 * contract (roll table); otherwise empty (a session opening, or a data switch).
 */
function carriedQuote(days: Map<EtDate, DayFile>, date: EtDate, schedule: RollSchedule): QuoteState {
  const wd = weekday(date);
  if (wd === 0 || wd === 6) return { ...EMPTY_QUOTE };
  const prev = days.get(addDays(date, -1));
  const contract = schedule.dataContractAt(etDayBounds(date).start);
  return prev && contract !== null && schedule.dataContractAt(etDayBounds(date).start - 1) === contract ? { ...prev.quoteEnd } : { ...EMPTY_QUOTE };
}

/** The manifest, recomputed from every day file of the store that still matches its source. */
export function buildManifest(
  dataDir: string,
  root: string,
  source: string,
  months: string[],
  missingMonths: string[],
  schedule: RollSchedule,
  log: (s: string) => void = () => {},
): Manifest {
  const stamps = new Map<string, FileStamp | null>();
  const stamp = (file: string) => {
    if (!stamps.has(file)) stamps.set(file, stampOf(join(source, file)));
    return stamps.get(file) ?? null;
  };
  const current = (r: SourceRef | null) => {
    if (!r) return true;
    const s = stamp(r.file);
    return !!s && s.size === r.size && s.mtime === r.mtime;
  };
  const dropped: Manifest["dropped"] = [];
  const days: DayFile[] = [];
  for (const date of listDays(dataDir, root)) {
    let d: DayFile | null = null;
    try {
      d = readDay(dataDir, root, date);
    } catch (e) {
      dropped.push({ date, reason: "unreadable" });
      log(`${(e as Error).message}; left out of the manifest`);
      continue;
    }
    if (!d) {
      dropped.push({ date, reason: "another store format" });
      continue;
    }
    if (!months.includes(date.slice(0, 7).replace("-", "")) || !current(d.l1) || !current(d.l2)) {
      dropped.push({ date, reason: "its source file changed or is gone, or its month isn't built" });
      log(`${dayPath(dataDir, root, date)}: its source changed or is gone; left out of the manifest`);
      continue;
    }
    days.push(d);
  }
  const summary: Manifest["days"] = {};
  const contracts: Manifest["contracts"] = {};
  for (const d of days) {
    summary[d.date] = {
      contract: d.contract,
      l1Rows: d.l1?.rows ?? 0,
      l1Kept: d.l1?.kept ?? 0,
      trades: d.l1?.trades ?? 0,
      bars: d.bars.t.length,
      l2Rows: d.l2?.rows ?? null,
      l2Kept: d.l2?.kept ?? null,
    };
    barContracts(d, schedule).forEach((code, i) => {
      if (code === null) return;
      const e = (contracts[code] ??= { first: iso(d.bars.t[i]), last: iso(d.bars.t[i]), bars: 0, days: [] });
      e.last = iso(d.bars.t[i]);
      e.bars++;
      if (e.days.at(-1) !== d.date) e.days.push(d.date);
    });
  }
  const gaps: Manifest["gaps"] = { l1: [], l2: [], holidays: [] };
  for (const month of months) {
    const first = `${month.slice(0, 4)}-${month.slice(4)}-01`;
    for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) {
      const wd = weekday(d);
      if (wd === 0 || wd === 6) continue;
      const s = summary[d];
      const noL1 = !s || s.trades === 0;
      const noL2 = !s || !s.l2Kept;
      if (!noL1 && !noL2) continue;
      if (isFullHoliday(d)) gaps.holidays.push(d);
      else {
        if (noL1) gaps.l1.push(d);
        if (noL2) gaps.l2.push(d);
      }
    }
  }
  return {
    format: STORE_FORMAT,
    root,
    source,
    months,
    missingMonths,
    days: summary,
    gaps,
    rollTable: { ...schedule.table, hash: schedule.hash },
    dropped,
    contracts,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
