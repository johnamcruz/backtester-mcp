import { createHash } from "node:crypto";
import { etDate, etDayBounds, type EtDate } from "./calendar.js";
import { NQ_QUARANTINE, type QuarantineEntry } from "./quarantine-nq.js";

/**
 * Which source row group serves which ET day, pure. A row group of the local
 * order-book data is meant to hold one ET day, but some don't: a file whose
 * clock runs late spills into the next day. So rows are dated by their own
 * timestamps (a census per row group: rows per ET date), and each ET date of
 * the month is served by one row group: of those with rows on it, the one
 * with the most rows on that date (then the largest share of its rows there,
 * then the first). The others' rows on that date are left out,
 * and that is recorded as a conflict; a day is never dropped silently. A day
 * file reads only its own date's hours from its row group (store.ts), so a row
 * group can serve more than one date. Quarantined row groups (quarantine-nq.ts)
 * serve none.
 */

/** Rows per ET date of one row group. */
export type Census = Record<EtDate, number>;

export interface GroupCensus {
  /** Relative to the source folder, e.g. "l1/202406.parquet". */
  file: string;
  rowGroup: number;
  rows: number;
  byDate: Census;
}

/** Two or more row groups with rows on one date: the one kept and those whose rows there are left out. */
export interface Conflict {
  date: EtDate;
  file: string;
  kept: { rowGroup: number; rows: number; share: number };
  dropped: Array<{ rowGroup: number; rows: number; share: number }>;
}

/** A row group with more than 1% of its rows outside its own day (the date of the file's month holding most of them). */
export interface Outside {
  file: string;
  rowGroup: number;
  rows: number;
  day: EtDate;
  outside: number;
  share: number;
}

/** A quarantined row group left out (rowsChanged: the source differs from the reviewed entry; missing: no such row group). */
export interface Quarantined {
  date: EtDate;
  file: string;
  rowGroup: number;
  rows: number | null;
  offsetMinutes: number;
  rowsChanged: boolean;
  missing: boolean;
}

export interface Assignment {
  days: Map<EtDate, GroupCensus>;
  conflicts: Conflict[];
  outside: Outside[];
  quarantined: Quarantined[];
}

/** Share of a row group's rows above which it is listed in `outside`. */
export const OUTSIDE_SHARE = 0.01;

const round = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * Rows per ET date of time-sorted µs timestamps: one etDate call per date, a
 * linear scan within it.
 */
export function censusOf(ts: Float64Array): Census {
  const out: Census = {};
  let i = 0;
  while (i < ts.length) {
    const d = etDate(Math.floor(ts[i] / 1000));
    const end = etDayBounds(d).end * 1000;
    let j = i;
    while (j < ts.length && ts[j] < end) j++;
    out[d] = (out[d] ?? 0) + (j - i);
    i = j;
  }
  return out;
}

/**
 * The census of a row group from its timestamp statistics alone (UTC ms, the µs
 * values floored, as hyparquet reads them: a floored time is on the same ET date
 * as the time itself, day bounds being whole ms), when they put every row on one
 * ET date; null when the rows must be read.
 */
export function censusFromStats(rows: number, min: number, max: number): Census | null {
  const d = etDate(min);
  return etDate(max) === d ? { [d]: rows } : null;
}

/** The quarantine entry refs of one source file (l1 or l2). */
export function quarantineOf(entries: readonly QuarantineEntry[], file: string): Array<{ entry: QuarantineEntry; rowGroup: number; rows: number }> {
  const out: Array<{ entry: QuarantineEntry; rowGroup: number; rows: number }> = [];
  for (const e of entries) for (const r of [e.l1, e.l2]) if (r && r.file === file) out.push({ entry: e, rowGroup: r.rowGroup, rows: r.rows });
  return out;
}

/**
 * Assign the ET dates of `month` (YYYYMM) to the row groups of one source file.
 * `groups` are that file's row groups with rows (any order); `quarantine` its
 * quarantine entries (quarantineOf).
 */
export function assignDays(month: string, file: string, groups: GroupCensus[], quarantine: Array<{ entry: QuarantineEntry; rowGroup: number; rows: number }>): Assignment {
  const prefix = `${month.slice(0, 4)}-${month.slice(4)}`;
  const quarantined: Quarantined[] = [];
  const out = new Set<number>();
  for (const q of quarantine) {
    const g = groups.find((x) => x.rowGroup === q.rowGroup);
    if (g) out.add(g.rowGroup);
    quarantined.push({
      date: q.entry.date,
      file,
      rowGroup: q.rowGroup,
      rows: g ? g.rows : null,
      offsetMinutes: q.entry.offsetMinutes,
      rowsChanged: !!g && g.rows !== q.rows,
      missing: !g,
    });
  }
  const usable = groups.filter((g) => g.rows > 0 && !out.has(g.rowGroup)).sort((a, b) => a.rowGroup - b.rowGroup);
  const candidates = new Map<EtDate, Array<{ g: GroupCensus; rows: number; share: number }>>();
  for (const g of usable) {
    for (const [d, n] of Object.entries(g.byDate)) {
      if (!n || !d.startsWith(prefix)) continue;
      const list = candidates.get(d) ?? [];
      list.push({ g, rows: n, share: n / g.rows });
      candidates.set(d, list);
    }
  }
  const days = new Map<EtDate, GroupCensus>();
  const conflicts: Conflict[] = [];
  for (const d of [...candidates.keys()].sort()) {
    const list = (candidates.get(d) ?? []).sort((a, b) => b.rows - a.rows || b.share - a.share || a.g.rowGroup - b.g.rowGroup);
    days.set(d, list[0].g);
    if (list.length > 1) {
      const pick = (c: (typeof list)[number]) => ({ rowGroup: c.g.rowGroup, rows: c.rows, share: round(c.share) });
      conflicts.push({ date: d, file, kept: pick(list[0]), dropped: list.slice(1).map(pick) });
    }
  }
  const outside: Outside[] = [];
  for (const g of usable) {
    // Its own day: the date of the month holding most of its rows (rows on other months' dates are never served
    // from this file, so they count as outside; a row group with none in the month is all outside).
    const inMonth = Object.entries(g.byDate).filter(([d]) => d.startsWith(prefix));
    const all = Object.entries(g.byDate).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [day, n] = inMonth.length ? inMonth.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] : [all[0]?.[0] ?? "", 0];
    const o = g.rows - n;
    if (o > OUTSIDE_SHARE * g.rows) outside.push({ file, rowGroup: g.rowGroup, rows: g.rows, day, outside: o, share: round(o / g.rows) });
  }
  return { days, conflicts, outside, quarantined };
}

/** The quarantined row groups of a root's source (quarantine-nq.ts; only NQ has one). */
export const quarantineTableOf = (root: string): readonly QuarantineEntry[] => (root === "NQ" ? NQ_QUARANTINE : []);

/** The hash of a root's quarantine table: a store or month assigned with another one isn't used. */
export const quarantineHashOf = (root: string) => createHash("sha256").update(JSON.stringify(quarantineTableOf(root))).digest("hex");

/**
 * Refuse a conflict where the row group kept has fewer rows on the date than one left out: a day would
 * lose most of its rows. Ranking by rows makes it impossible; this guard keeps a later ranking change from
 * doing it silently.
 */
export function assertConflicts(conflicts: Conflict[]): void {
  for (const c of conflicts) {
    const big = c.dropped.find((x) => x.rows > c.kept.rows);
    if (big) {
      throw new Error(
        `${c.file}: on ${c.date} row group ${c.kept.rowGroup} (${c.kept.rows} rows there) was kept over row group ${big.rowGroup} (${big.rows} rows there): refusing to build; review the day assignment`,
      );
    }
  }
}

/** A run of minutes [from, to) (ISO), as projectx-mcp's orderflow.ts#gapsOf reports them. */
export interface MinuteRun {
  from: string;
  to: string;
  minutes: number;
}

/**
 * Runs of expected minutes with no data: `expected` are UTC ms ranges (sorted,
 * not overlapping), `has` says whether a minute (its open, UTC ms) has data.
 * Consecutive missing minutes form one run, also across the end of one range
 * and the start of the next when they meet (00:00 ET), never across a break.
 */
export function missingRuns(expected: Array<[number, number]>, has: (minute: number) => boolean): MinuteRun[] {
  const MIN = 60000;
  const out: MinuteRun[] = [];
  let start: number | null = null;
  let end = 0;
  const close = () => {
    if (start !== null) out.push({ from: new Date(start).toISOString(), to: new Date(end).toISOString(), minutes: (end - start) / MIN });
    start = null;
  };
  for (const [a, b] of expected) {
    for (let t = Math.ceil(a / MIN) * MIN; t < b; t += MIN) {
      if (has(t)) close();
      else {
        if (start !== null && end !== t) close();
        if (start === null) start = t;
        end = t + MIN;
      }
    }
  }
  close();
  return out;
}
