import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { tradingDayStart } from "./risk.js";

export const MINUTE = 60000;

/**
 * One-minute bars of a back-adjusted continuous series, columnar. `t` is the
 * bar's open time (ms, UTC); a bar is closed once `t + 1 minute <= now`.
 */
export class BarSeries {
  constructor(
    readonly t: Float64Array,
    readonly o: Float64Array,
    readonly h: Float64Array,
    readonly l: Float64Array,
    readonly c: Float64Array,
    readonly v: Float64Array,
  ) {}

  get length(): number {
    return this.t.length;
  }

  /** First index with t >= ms. */
  lowerBound(ms: number): number {
    let lo = 0;
    let hi = this.t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Number of bars closed at `now` (closed bars are the prefix [0, n)). */
  closedCount(now: number): number {
    return this.lowerBound(now - MINUTE + 1);
  }

  bar(i: number): Bar {
    return { t: this.t[i], o: this.o[i], h: this.h[i], l: this.l[i], c: this.c[i], v: this.v[i] };
  }
}

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const FAST_TS = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?(Z|[+-]00:?00)?$/;

/** "2024-03-04 14:30:00+00:00" (or ISO with Z) -> ms. Timestamps are UTC. */
export function parseTimestamp(s: string): number {
  const m = FAST_TS.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new Error(`bad timestamp "${s}"`);
  return ms;
}

/** Parse a `datetime,open,high,low,close,volume` CSV (oldest first; duplicates keep the first row). */
export function parseCsv(text: string, source = "csv"): BarSeries {
  const lines = text.split(/\r?\n/);
  const header = lines[0]?.trim().toLowerCase().replace(/\s+/g, "");
  if (header !== "datetime,open,high,low,close,volume") {
    throw new Error(`${source}: header must be datetime,open,high,low,close,volume, got "${lines[0]?.slice(0, 80)}"`);
  }
  const n = lines.length - 1;
  const cols = [0, 1, 2, 3, 4, 5].map(() => new Float64Array(n));
  let k = 0;
  let last = -Infinity;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split(",");
    if (f.length < 6) throw new Error(`${source}:${i + 1}: expected 6 columns`);
    const t = parseTimestamp(f[0].trim());
    if (t < last) throw new Error(`${source}:${i + 1}: rows are not oldest first`);
    if (t === last) continue;
    last = t;
    cols[0][k] = t;
    for (let j = 1; j < 6; j++) {
      const x = Number(f[j]);
      if (!Number.isFinite(x)) throw new Error(`${source}:${i + 1}: bad number "${f[j]}"`);
      cols[j][k] = x;
    }
    k++;
  }
  const [t, o, h, l, c, v] = cols.map((a) => a.slice(0, k));
  return new BarSeries(t, o, h, l, c, v);
}

export const dataFile = (dataDir: string, dataRoot: string) => join(dataDir, `${dataRoot}_1min.csv`);

/** Loads a root's 1-minute file once per process. */
export class BarStore {
  private readonly cache = new Map<string, BarSeries>();

  constructor(private readonly dataDir: string) {}

  has(dataRoot: string): boolean {
    return this.cache.has(dataRoot) || existsSync(dataFile(this.dataDir, dataRoot));
  }

  get(dataRoot: string): BarSeries {
    let s = this.cache.get(dataRoot);
    if (!s) {
      const file = dataFile(this.dataDir, dataRoot);
      if (!existsSync(file)) throw new Error(`no data file ${file}`);
      s = parseCsv(readFileSync(file, "utf8"), file);
      this.cache.set(dataRoot, s);
    }
    return s;
  }

  /** First and last bar times of a file, read from its head and tail only (no full load). */
  range(dataRoot: string): { first: string; last: string } | null {
    const cached = this.cache.get(dataRoot);
    if (cached) return cached.length ? { first: iso(cached.t[0]), last: iso(cached.t[cached.length - 1]) } : null;
    const file = dataFile(this.dataDir, dataRoot);
    if (!existsSync(file)) return null;
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const read = (pos: number, len: number) => {
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, pos);
        return buf.subarray(0, n).toString("utf8");
      };
      const head = read(0, Math.min(size, 4096)).split(/\r?\n/)[1];
      const tail = read(Math.max(0, size - 4096), Math.min(size, 4096)).split(/\r?\n/).filter(Boolean).pop();
      if (!head || !tail || tail.startsWith("datetime")) return null;
      return { first: iso(parseTimestamp(head.split(",")[0].trim())), last: iso(parseTimestamp(tail.split(",")[0].trim())) };
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

// ── Aggregation ──────────────────────────────────────────────────────

export type AggUnit = "minute" | "hour" | "day" | "week";

/** Bucket of a bar time: [start, end). Minutes and hours align to UTC; days and weeks to the 17:00 CT trading day. */
export function bucketOf(unit: AggUnit, n: number): (ms: number) => { start: number; end: number } {
  if (unit === "minute" || unit === "hour") {
    const size = n * (unit === "minute" ? MINUTE : 60 * MINUTE);
    return (ms) => {
      const start = Math.floor(ms / size) * size;
      return { start, end: start + size };
    };
  }
  if (unit === "day") {
    // n trading days per bucket, counted from the epoch's trading days (n = 1 is the usual daily bar).
    return (ms) => {
      const start = tradingDayStart(new Date(ms)).getTime();
      let end = start;
      for (let i = 0; i < n; i++) end = tradingDayStart(new Date(end + 26 * 36e5)).getTime();
      return { start, end };
    };
  }
  // Weeks start at the Sunday 17:00 CT open and end at the Friday 17:00 CT close.
  return (ms) => {
    let start = tradingDayStart(new Date(ms)).getTime();
    // Walk back to the trading day that starts on a Sunday (Chicago); at most 6 steps.
    for (let i = 0; i < 7 && chicagoWeekday(start) !== 0; i++) start = tradingDayStart(new Date(start - 36e5)).getTime();
    let end = start;
    for (let i = 0; i < 5 * n; i++) end = tradingDayStart(new Date(end + 26 * 36e5)).getTime();
    return { start, end };
  };
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short" });
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function chicagoWeekday(ms: number): number {
  return DAYS.indexOf(WEEKDAY.format(new Date(ms)));
}

export interface OutBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Aggregate 1-minute bars into buckets, using only bars closed at `cutoff`.
 * Returns buckets with start in [from, to) whose end <= cutoff, plus the
 * still-forming bucket when `partial` is set, the newest `limit` of them,
 * oldest first.
 */
export function aggregate(
  s: BarSeries,
  opts: { unit: AggUnit; unitNumber: number; limit: number; from: number | null; to: number; cutoff: number; partial: boolean },
): OutBar[] {
  const bucket = bucketOf(opts.unit, opts.unitNumber);
  const closed = s.closedCount(opts.cutoff);
  const out: Array<OutBar & { end: number }> = [];
  // Walk backward from the newest closed bar, building buckets until `limit` are complete.
  // Bars past the last bucket that starts before `to` can't contribute: skip them.
  let i = (Number.isFinite(opts.to) ? Math.min(closed, s.lowerBound(bucket(opts.to - 1).end)) : closed) - 1;
  let cur: (OutBar & { end: number; start: number }) | null = null;
  const push = () => {
    if (!cur) return;
    const keep = cur.start < opts.to && (opts.from === null || cur.start >= opts.from) && (cur.end <= opts.cutoff || opts.partial);
    if (keep) out.push(cur);
    cur = null;
  };
  for (; i >= 0; i--) {
    const t = s.t[i];
    if (opts.from !== null && t < opts.from) break;
    if (cur === null || t < cur.start) {
      push();
      if (out.length >= opts.limit) break;
      const b = bucket(t);
      cur = { start: b.start, end: b.end, t: new Date(b.start).toISOString(), o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i], v: s.v[i] };
    } else {
      // Walking backward: this bar is earlier, so it sets the open.
      cur.o = s.o[i];
      if (s.h[i] > cur.h) cur.h = s.h[i];
      if (s.l[i] < cur.l) cur.l = s.l[i];
      cur.v += s.v[i];
    }
  }
  if (out.length < opts.limit) push();
  return out
    .slice(0, opts.limit)
    .reverse()
    .map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v: Math.round(v * 1e6) / 1e6 }));
}
