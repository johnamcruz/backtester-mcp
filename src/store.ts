import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { BarSeries } from "./bars.js";
import { etDate, type EtDate } from "./calendar.js";
import { EMPTY_QUOTE, normalizeL1, normalizeL2, type DepthEvent, type MinuteBars, type QuoteEvent, type QuoteState, type TradeEvent } from "./events.js";
import { ParquetFile } from "./parquet.js";
import { FLOW_FORMAT, flowRecords, readFlowDay, type FlowDay, type FlowSummary } from "./flowstore.js";
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
  /** Weekdays of built months without L1 trades / without L2 rows (full holidays listed apart). */
  gaps: { l1: EtDate[]; l2: EtDate[]; holidays: EtDate[] };
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
  private readonly hashes = new Map<string, string | null>();
  private readonly series = new Map<string, BarSeries>();
  private readonly flowDays = new Map<string, FlowDay | null>();

  constructor(
    private readonly dataDir: string,
    /** Overrides the manifest's source folder for event reads (BACKTESTER_ORDERBOOK_DIR). */
    private readonly sourceDir: string | null = null,
  ) {}

  /**
   * The root's manifest, read once. A store built with another roll table than
   * this code's is not used (its contract index would be wrong): rebuild it.
   */
  manifest(root: string): Manifest | null {
    if (!this.manifests.has(root)) {
      const p = manifestPath(this.dataDir, root);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;
      let m = text === null ? null : (JSON.parse(text) as Manifest);
      if (m && m.format !== STORE_FORMAT) m = null;
      const schedule = scheduleOf(root);
      if (m && (!schedule || m.rollTable?.hash !== schedule.hash)) {
        process.stderr.write(`[backtester-mcp] ${p} was built with another roll table: not used (rerun build-store)\n`);
        m = null;
      }
      this.manifests.set(root, m);
      this.hashes.set(root, m && text ? createHash("sha256").update(text).digest("hex") : null);
    }
    return this.manifests.get(root) ?? null;
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
    for (const date of entry.days) {
      const day = readDay(this.dataDir, root, date);
      if (!day) throw new Error(`store day file ${date} of ${root} is missing or of another format: rebuild with build-store`);
      const owner = barContracts(day, scheduleOf(root) as RollSchedule);
      const b = day.bars;
      for (let i = 0; i < b.t.length; i++) {
        if (owner[i] !== code) continue;
        cols[0].push(b.t[i]);
        cols[1].push(b.o[i]);
        cols[2].push(b.h[i]);
        cols[3].push(b.l[i]);
        cols[4].push(b.c[i]);
        cols[5].push(b.v[i]);
      }
    }
    const [t, o, h, l, c, v] = cols.map((x) => Float64Array.from(x));
    s = new BarSeries(t, o, h, l, c, v);
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
