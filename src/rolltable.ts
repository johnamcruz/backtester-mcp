import { createHash } from "node:crypto";
import { expiryMoment, parseMonthCode, tradingDayStartEt } from "./calendar.js";
import { NQ_EXCEPTIONS, NQ_ROLLS, NQ_TABLE_END, NQ_TABLE_START } from "./rolltable-nq.js";

/**
 * The reviewed roll table of the local NQ data: which contract the raw data is
 * on at every moment. The data has no contract column, so this was derived
 * per roll from the data itself (scripts/derive-roll-table.ts: the offset to a
 * back-adjusted series of the same data names the raw contract) and reviewed;
 * see rolltable-nq.ts. Contract assignment comes only from this table: no
 * heuristic at runtime, no look-ahead, and never a contract past its expiry
 * (third Friday 09:30 ET): what the data holds after that is unassigned.
 */

/** A roll of the data: from `at` (ISO, 00:00 ET) the data is on `to` instead of `from`. */
export interface RollEntry {
  from: string;
  to: string;
  at: string;
  note?: string;
}

/** A stretch where the data is on another contract than the rolls give (null: not usable). */
export interface DataException {
  from: string;
  to: string;
  contract: string | null;
  note: string;
}

export interface RollTable {
  root: string;
  start: string;
  end: string;
  rolls: RollEntry[];
  exceptions: DataException[];
}

export const NQ_TABLE: RollTable = { root: "NQ", start: NQ_TABLE_START, end: NQ_TABLE_END, rolls: NQ_ROLLS, exceptions: NQ_EXCEPTIONS };

/** One stretch of the data: [from, to) on `contract` (null: no contract assigned). */
export interface Segment {
  from: number;
  to: number;
  contract: string | null;
}

const expiryOf = (code: string) => {
  const c = parseMonthCode(code);
  if (!c) throw new Error(`roll table: bad contract code ${code}`);
  return expiryMoment(c);
};

/**
 * The table as contiguous segments from its start to its end: the front by the
 * rolls, overridden by the exceptions, each cut at its contract's expiry.
 */
export function segments(table: RollTable): Segment[] {
  const start = Date.parse(table.start);
  const end = Date.parse(table.end);
  const cuts = new Set<number>([start, end]);
  for (const r of table.rolls) cuts.add(Date.parse(r.at));
  for (const e of table.exceptions) {
    cuts.add(Date.parse(e.from));
    cuts.add(Date.parse(e.to));
  }
  const codes = new Set<string>();
  for (const r of table.rolls) codes.add(r.from).add(r.to);
  for (const e of table.exceptions) if (e.contract) codes.add(e.contract);
  for (const code of codes) cuts.add(expiryOf(code));
  const points = [...cuts].filter((t) => t >= start && t <= end).sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i];
    const ex = table.exceptions.find((e) => Date.parse(e.from) <= from && from < Date.parse(e.to));
    let contract = ex ? ex.contract : frontByRolls(table, from);
    if (contract !== null && from >= expiryOf(contract)) contract = null;
    const last = out.at(-1);
    if (last && last.contract === contract) last.to = points[i + 1];
    else out.push({ from, to: points[i + 1], contract });
  }
  return out;
}

function frontByRolls(table: RollTable, ms: number): string {
  let front = table.rolls[0].from;
  for (const r of table.rolls) if (Date.parse(r.at) <= ms) front = r.to;
  return front;
}

/** Index of the segment holding `ms`, or -1 outside the table. */
function find(segs: Segment[], ms: number): number {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ms < segs[mid].from) hi = mid - 1;
    else if (ms >= segs[mid].to) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Contract assignment from a roll table, precomputed. */
export class RollSchedule {
  readonly segments: Segment[];
  readonly hash: string;

  constructor(readonly table: RollTable) {
    this.segments = segments(table);
    this.hash = createHash("sha256").update(JSON.stringify(table)).digest("hex");
  }

  covers(ms: number): boolean {
    return find(this.segments, ms) >= 0;
  }

  /** The contract the data is on at `ms` (null: none, or outside the table). */
  dataContractAt(ms: number): string | null {
    const i = find(this.segments, ms);
    return i < 0 ? null : this.segments[i].contract;
  }

  /**
   * The front (active) contract at `ms`, as a live broker shows it: it changes at
   * the start of the CME trading day (18:00 ET) in which the data rolls, so a
   * trading day has one front month. Between that 18:00 and the data's 00:00 ET
   * switch the new front has no bars yet (none are made up). Null outside the table.
   */
  activeAt(ms: number): string | null {
    if (!this.covers(ms)) return null;
    let front = this.table.rolls[0].from;
    for (const r of this.table.rolls) if (tradingDayStartEt(Date.parse(r.at)) <= ms) front = r.to;
    return front;
  }

  /**
   * Moments in (from, to] when the data leaves a contract for good: settlements of what is open on
   * it. That is its roll in the table's rolls (an exception dated after the roll, like M22's
   * expiry-day file, doesn't hold it off), and the end of its last segment when that comes later (what
   * was opened on it in such a stretch). A stretch the data spends on another contract before the
   * roll and comes back from is a gap, not a settlement.
   */
  switchesBetween(from: number, to: number): Array<{ at: number; off: string }> {
    const end = Date.parse(this.table.end);
    const moments: Array<{ at: number; off: string }> = [];
    for (const r of this.table.rolls) moments.push({ at: Date.parse(r.at), off: r.from });
    const last = new Map<string, number>();
    for (const s of this.segments) if (s.contract !== null) last.set(s.contract, s.to);
    for (const [off, at] of last) if (!moments.some((m) => m.off === off && m.at >= at)) moments.push({ at, off });
    return moments.filter((m) => m.at > from && m.at <= to && m.at < end).sort((a, b) => a.at - b.at || a.off.localeCompare(b.off));
  }
}

export const NQ_SCHEDULE = new RollSchedule(NQ_TABLE);

/** The roll schedule of a root's data (only NQ has one). */
export function scheduleOf(root: string): RollSchedule | null {
  return root === "NQ" ? NQ_SCHEDULE : null;
}
