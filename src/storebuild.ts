import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { addDays, etDayBounds, expectedRanges, isFullHoliday, sessionsOf, weekday, type EtDate } from "./calendar.js";
import {
  assertConflicts,
  assignDays,
  censusFromStats,
  censusOf,
  missingRuns,
  quarantineHashOf,
  quarantineOf as quarantineRefs,
  quarantineTableOf,
  type Conflict,
  type GroupCensus,
  type Outside,
  type Quarantined,
} from "./dayassign.js";
import { EMPTY_QUOTE, keepRow, minuteBars, minuteIndex, normalizeL1, type QuoteState } from "./events.js";
import { buildFlowDays, flowDayPath, flowSummary } from "./flowstore.js";
import { ParquetFile } from "./parquet.js";
import { scheduleOf, type RollSchedule } from "./rolltable.js";
import {
  L1_COLUMNS,
  assignPath,
  buildingPath,
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
 * store.ts for the layout). Months in order; in each, the ET days are assigned
 * to row groups by the rows' own timestamps (dayassign.ts; quarantined row
 * groups serve none), then built one day at a time. A day whose file already
 * matches its source (file, size, mtime, row group, rows), its hours and the
 * quote state carried into it is skipped, so a build can be stopped and
 * resumed, and running it twice changes nothing. One build at a time per store
 * (a lock file). After the days, the manifest is recomputed from every day
 * file still matching its source: gaps and contracts, by the reviewed roll
 * table, and the months' assignment reports.
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
  /** Build the order flow too (flowstore.ts; default true). */
  flow?: boolean;
}

export interface BuildSummary {
  months: string[];
  missingMonths: string[];
  built: EtDate[];
  skipped: EtDate[];
  /** Day files removed: dates no row group serves any more. */
  removed: EtDate[];
  /** Days whose order flow was built / was already current. */
  flowBuilt: EtDate[];
  flowSkipped: EtDate[];
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


/** One month's day assignment, kept in the store for the manifest (store.ts#assignPath). */
export interface MonthReport {
  month: string;
  l1: { file: string; size: number; mtime: number };
  l2: { file: string; size: number; mtime: number } | null;
  conflicts: Conflict[];
  outside: Outside[];
  quarantined: Quarantined[];
  /** The quarantine table it was assigned with (dayassign.ts#quarantineHashOf). */
  quarantineHash: string;
}

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

const sameSessions = (a: Array<[number, number]> | undefined, b: Array<[number, number]>) => JSON.stringify(a) === JSON.stringify(b);

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
    // Until the new manifest is written (last, atomically), the store is marked as being built: a reader
    // refuses it (store.ts#refusal), so a crash midway never leaves a mixed store served as valid.
    writeAtomic(buildingPath(o.dataDir, root), JSON.stringify({ pid: process.pid, from: o.from, to: o.to }));
    const summary = await build(o, root, source, months, schedule, log);
    unlinkSync(buildingPath(o.dataDir, root));
    return summary;
  } finally {
    unlock();
  }
}

async function build(o: BuildOptions, root: string, source: string, months: string[], schedule: RollSchedule, log: (s: string) => void): Promise<BuildSummary> {
  const t0 = performance.now();
  let rows = 0;
  const built: EtDate[] = [];
  const skipped: EtDate[] = [];
  const removed: EtDate[] = [];
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
  const flowBuilt: EtDate[] = [];
  const flowSkipped: EtDate[] = [];

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
    const prefix = `${month.slice(0, 4)}-${month.slice(4)}`;

    // Which row group serves which ET day: by the rows' own timestamps (dayassign.ts).
    const census = async (f: ParquetFile, file: string): Promise<GroupCensus[]> => {
      const out: GroupCensus[] = [];
      for (const g of f.rowGroups) {
        if (!g.rows) continue;
        const r = f.tsRange(g.index);
        let byDate = r ? censusFromStats(g.rows, r.min, r.max) : null;
        if (!byDate) {
          byDate = censusOf((await f.read(g.index, ["ts"])).ts);
          rows += g.rows;
        }
        out.push({ file, rowGroup: g.index, rows: g.rows, byDate });
      }
      return out;
    };
    const quarantine = quarantineTableOf(root);
    const a1 = assignDays(month, l1Name, await census(l1, l1Name), quarantineRefs(quarantine, l1Name));
    const a2 = l2 ? assignDays(month, l2Name, await census(l2, l2Name), quarantineRefs(quarantine, l2Name)) : null;
    const report: MonthReport = {
      month,
      l1: { file: l1Name, ...l1Stamp },
      l2: l2Stamp ? { file: l2Name, ...l2Stamp } : null,
      conflicts: [...a1.conflicts, ...(a2?.conflicts ?? [])],
      outside: [...a1.outside, ...(a2?.outside ?? [])],
      quarantined: [...a1.quarantined, ...(a2?.quarantined ?? [])],
      quarantineHash: quarantineHashOf(root),
    };
    for (const q of report.quarantined) {
      log(
        `${month}: ${q.file} row group ${q.rowGroup} quarantined (${q.date}, clock ${q.offsetMinutes} min late)` +
          (q.missing ? ": no such row group (review the quarantine table)" : q.rowsChanged ? `: ${q.rows} rows, not the reviewed count (review the quarantine table)` : ""),
      );
    }
    for (const c of report.conflicts) {
      log(`${month}: ${c.file} row groups ${[c.kept, ...c.dropped].map((x) => x.rowGroup).join(", ")} all have rows on ${c.date}; row group ${c.kept.rowGroup} is kept (${c.kept.rows} rows there)`);
    }
    assertConflicts(report.conflicts);
    writeAtomic(assignPath(o.dataDir, root, month), JSON.stringify(report, null, 1));

    const dates = [...new Set([...a1.days.keys(), ...(a2?.days.keys() ?? [])])].sort();
    // A day of this month no row group serves any more (quarantined, or now dated otherwise): its files go.
    for (const date of [...existing.keys()].filter((d) => d.startsWith(prefix) && !dates.includes(d))) {
      for (const p of [dayPath(o.dataDir, root, date), flowDayPath(o.dataDir, root, date)]) if (existsSync(p)) unlinkSync(p);
      existing.delete(date);
      removed.push(date);
      log(`${date}: no row group serves it any more; its day file is removed`);
    }

    for (const date of dates) {
      const sessions = sessionsOf(date);
      const prior = existing.get(date);
      const same = !!prior && sameSessions(prior.sessions, sessions);
      const g1 = a1.days.get(date);
      const g2 = a2?.days.get(date);
      let l2Ref: SourceRef | null = null;
      if (g2) {
        if (same && prior?.l2 && sameRef(prior.l2, l2Name, l2Stamp as FileStamp, g2.rowGroup, g2.rows)) l2Ref = prior.l2;
        else {
          const { ts } = await (l2 as ParquetFile).read(g2.rowGroup, ["ts"]);
          rows += g2.rows;
          l2Ref = { file: l2Name, ...(l2Stamp as FileStamp), rowGroup: g2.rowGroup, rows: g2.rows, kept: countKept(ts, sessions), index: minuteIndex(ts) };
        }
      }
      const quoteStart = g1 ? carriedQuote(existing, date, sessions, schedule) : { ...EMPTY_QUOTE };
      if (same && prior && sameL2(prior.l2, l2Ref ?? undefined) && sameQuote(prior.quoteStart, quoteStart) && (g1 ? sameRef(prior.l1, l1Name, l1Stamp, g1.rowGroup, g1.rows) : !prior.l1)) {
        skipped.push(date);
        continue;
      }
      const t1 = performance.now();
      let day: DayFile;
      if (g1) {
        const cols = await l1.read(g1.rowGroup, L1_COLUMNS);
        rows += g1.rows;
        const n = normalizeL1(cols, sessions, quoteStart, { quotes: false });
        day = {
          format: STORE_FORMAT,
          root,
          date,
          contract: schedule.dataContractAt(etDayBounds(date).start),
          sessions,
          l1: { file: l1Name, ...l1Stamp, rowGroup: g1.rowGroup, rows: g1.rows, kept: n.kept, trades: n.trades.length, index: minuteIndex(cols.ts) },
          l2: l2Ref,
          quoteStart,
          quoteEnd: { ...n.end },
          bars: minuteBars(n.trades),
        };
        log(
          `${date} ${root}${day.contract ?? "-"}: L1 ${g1.rows} rows (${n.kept} kept, ${n.trades.length} trades, ${day.bars.t.length} bars)` +
            `, L2 ${day.l2 ? `${day.l2.rows} rows` : "none"}, ${((performance.now() - t1) / 1000).toFixed(1)} s`,
        );
      } else {
        // An L2 day with no L1 row group still gets a day file (no bars).
        day = {
          format: STORE_FORMAT,
          root,
          date,
          contract: schedule.dataContractAt(etDayBounds(date).start),
          sessions,
          l1: null,
          l2: l2Ref,
          quoteStart: { ...EMPTY_QUOTE },
          quoteEnd: { ...EMPTY_QUOTE },
          bars: { t: [], o: [], h: [], l: [], c: [], v: [] },
        };
      }
      writeDay(o.dataDir, day);
      existing.set(date, day);
      built.push(date);
    }
    if (o.flow !== false) {
      const prefix = `${month.slice(0, 4)}-${month.slice(4)}`;
      const f = await buildFlowDays({ source, dataDir: o.dataDir, root, days: [...existing.values()].filter((d) => d.date.startsWith(prefix)), schedule, log });
      flowBuilt.push(...f.built);
      flowSkipped.push(...f.skipped);
      rows += f.rows;
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
      (removed.length ? `, ${removed.length} removed` : "") +
      `; gaps L1 ${manifest.gaps.l1.length}, L2 ${manifest.gaps.l2.length}, ${manifest.gaps.minutes.length} minute runs; ${manifest.dropped.length} day files left out` +
      `; ${manifest.assignment.conflicts.length} day conflicts, ${manifest.assignment.quarantined.filter((q) => !q.missing).length} row groups quarantined` +
      `; order flow: ${flowBuilt.length} days built, ${flowSkipped.length} up to date, ${manifest.flow?.days.length ?? 0} current in the store`,
  );
  return { months: doneMonths, missingMonths, built, skipped, removed, flowBuilt, flowSkipped, rows, seconds, manifest };
}

function countKept(ts: Float64Array, ranges: Array<[number, number]>): number {
  let n = 0;
  for (let i = 0; i < ts.length; i++) if (keepRow(ts[i], ranges)) n++;
  return n;
}

/**
 * The quote state a day starts with: the previous ET day's end state when the
 * session runs on over midnight into this day (its hours start at 00:00 ET:
 * Monday to Friday, not after a closed trade date) on the same contract (roll
 * table); otherwise empty (a session opening, or a data switch).
 */
function carriedQuote(days: Map<EtDate, DayFile>, date: EtDate, sessions: Array<[number, number]>, schedule: RollSchedule): QuoteState {
  if (sessions[0]?.[0] !== etDayBounds(date).start) return { ...EMPTY_QUOTE };
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
  const gaps: Manifest["gaps"] = { l1: [], l2: [], holidays: [], minutes: [] };
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
  // Minute gaps: expected minutes (Globex hours, the CME calendar) of the built months without an L1 row.
  // A day's index covers its whole row group: only the minutes of its own ET day count for it.
  const withRows = new Set<number>();
  for (const d of days) {
    const { start, end } = etDayBounds(d.date);
    for (const [t] of d.l1?.index ?? []) if (t >= start && t < end) withRows.add(t);
  }
  const expected: Array<[number, number]> = [];
  for (const month of months) {
    const first = `${month.slice(0, 4)}-${month.slice(4)}-01`;
    for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) expected.push(...expectedRanges(d));
  }
  gaps.minutes = missingRuns(expected, (t) => withRows.has(t));
  const flow = flowSummary(dataDir, root, days, schedule);
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
    assignment: assignmentOf(dataDir, root, source, months, stamp),
    contracts,
    ...(flow.days.length ? { flow } : {}),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The months' assignment reports, where current (same source files, same quarantine table); the others are `unchecked`. */
function assignmentOf(dataDir: string, root: string, source: string, months: string[], stamp: (file: string) => FileStamp | null): Manifest["assignment"] {
  const out: Manifest["assignment"] = {
    conflicts: [],
    outside: [],
    quarantined: [],
    quarantineHash: quarantineHashOf(root),
    unchecked: [],
  };
  const current = (f: { file: string; size: number; mtime: number } | null, file: string) => {
    const s = stamp(file);
    return f ? !!s && f.file === file && s.size === f.size && s.mtime === f.mtime : s === null;
  };
  for (const month of months) {
    const p = assignPath(dataDir, root, month);
    let r: MonthReport | null = null;
    try {
      r = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as MonthReport) : null;
    } catch {
      r = null;
    }
    if (!r || r.quarantineHash !== out.quarantineHash || !current(r.l1, `l1/${month}.parquet`) || !current(r.l2, `l2/${month}.parquet`)) {
      out.unchecked.push(month);
      continue;
    }
    out.conflicts.push(...r.conflicts);
    out.outside.push(...r.outside);
    out.quarantined.push(...r.quarantined);
  }
  return out;
}
