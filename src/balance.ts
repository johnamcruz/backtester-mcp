import { readFileSync } from "node:fs";
import { realizedNet, type TradeLike } from "./risk.js";

/**
 * The balance schedule (BACKTESTER_BALANCE_SCHEDULE, replay only): a JSON list the replay driver appends to, each
 * entry `{ at, balance, dayPnl }` saying the account's balance is `balance` from replay time `at` on, of which
 * `dayPnl` was realized earlier in that trading day. A practice day of the harness starts from an account state (a
 * balance part way through an attempt, after losses today); the account must read that balance, and the daily loss
 * limit must count that day's P&L, as a live account in that state would. Live accounts have real balances: this is
 * never a live setting, and it is not an interface field (get_account and get_account_snapshot report the balance and
 * the day's P&L as they always do).
 *
 * The balance at `now`: the latest entry at or before it, plus every fill after the entry's time (none: the start
 * balance plus every fill). Today's realized P&L: the entry's dayPnl plus today's fills after it, when the latest entry
 * falls in today's trading day; else today's fills alone. The file is re-read on every call (the driver writes it
 * between steps); a missing file is an empty schedule; an unreadable or malformed one throws (fails closed: a wrong
 * balance would size every trade wrong).
 */
export interface BalanceEntry {
  at: number;
  balance: number;
  dayPnl: number;
}

type Trade = TradeLike & { creationTimestamp: string };

export function readSchedule(file: string | null): BalanceEntry[] {
  if (!file) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`The balance schedule ${file} is unreadable: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new Error(`The balance schedule ${file} is not a list.`);
  return raw.map((x, i) => {
    const e = x as { at?: unknown; balance?: unknown; dayPnl?: unknown };
    const at = Date.parse(String(e.at));
    const balance = Number(e.balance);
    const dayPnl = e.dayPnl === undefined ? 0 : Number(e.dayPnl);
    if (!Number.isFinite(at) || !Number.isFinite(balance) || balance <= 0 || !Number.isFinite(dayPnl)) {
      throw new Error(`The balance schedule ${file} has a malformed entry ${i}: { at: <ISO>, balance: <above 0>, dayPnl: <number> }.`);
    }
    return { at, balance, dayPnl };
  }).sort((a, b) => a.at - b.at);
}

/** The latest entry at or before `nowMs`, or null. */
export function entryAt(schedule: BalanceEntry[], nowMs: number): BalanceEntry | null {
  let hit: BalanceEntry | null = null;
  for (const e of schedule) if (e.at <= nowMs) hit = e;
  return hit;
}

const after = (trades: Trade[], ms: number) => trades.filter((t) => Date.parse(t.creationTimestamp) > ms);
const round2 = (x: number) => Math.round(x * 100) / 100;

/** The account balance at `nowMs`: the schedule's latest entry plus the fills after it, else start plus every fill. */
export function balanceAt(startBalance: number, trades: Trade[], schedule: BalanceEntry[], nowMs: number): number {
  const e = entryAt(schedule, nowMs);
  return round2(e ? e.balance + realizedNet(after(trades, e.at)) : startBalance + realizedNet(trades));
}

/** Today's realized P&L at `nowMs` (`today`: the fills since `dayStartMs`), the schedule's carried P&L counted. */
export function realizedToday(today: Trade[], schedule: BalanceEntry[], nowMs: number, dayStartMs: number): number {
  const e = entryAt(schedule, nowMs);
  if (e && e.at >= dayStartMs) return e.dayPnl + realizedNet(after(today, e.at));
  return realizedNet(today);
}
