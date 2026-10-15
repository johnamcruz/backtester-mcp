import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { balanceAt, entryAt, readSchedule, realizedToday } from "../src/balance.js";
import { MIN, RATIONALE, T0, iso, setup, tmp } from "./helpers.js";

const order = { accountId: 1, contractId: "BT.MNQ", type: "market", side: "buy", size: 1, rationale: RATIONALE };
const fill = (ms: number, pnl: number | null, fees = 0.37) => ({ creationTimestamp: iso(ms), profitAndLoss: pnl, fees, voided: false });

/** A schedule file with these entries. */
function schedule(entries: Array<Record<string, unknown>>): string {
  const file = join(tmp(), "balance-schedule.json");
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

describe("the balance schedule (replay only: a practice day's account state)", () => {
  it("the balance is the latest entry at or before now plus the fills after it; none, the start balance plus every fill", () => {
    const sch = [{ at: T0, balance: 48700, dayPnl: -600 }, { at: T0 + 60 * MIN, balance: 51000, dayPnl: 0 }];
    const trades = [fill(T0 - 5 * MIN, -50), fill(T0 + 5 * MIN, null), fill(T0 + 10 * MIN, -20)];
    expect(balanceAt(100000, trades, [], T0 + 20 * MIN)).toBe(99928.89);
    expect(balanceAt(100000, trades.slice(0, 1), sch, T0 - MIN)).toBe(99949.63);
    expect(balanceAt(100000, trades, sch, T0 + 20 * MIN)).toBe(48679.26);
    expect(balanceAt(100000, trades, sch, T0 + 61 * MIN)).toBe(51000);
    expect(entryAt(sch, T0 - 1)).toBeNull();
  });

  it("today's realized P&L carries the entry's dayPnl when the entry is today's; another day's never", () => {
    const sch = [{ at: T0, balance: 48700, dayPnl: -600 }];
    const today = [fill(T0 + 5 * MIN, null), fill(T0 + 10 * MIN, -20)];
    const dayStart = Date.parse("2024-03-04T23:00:00Z");
    expect(realizedToday(today, sch, T0 + 20 * MIN, dayStart)).toBeCloseTo(-600 - 0.37 - 20.37, 6);
    expect(realizedToday(today, sch, T0 + 20 * MIN, T0 + MIN)).toBeCloseTo(-0.37 - 20.37, 6);
    expect(realizedToday(today, [], T0 + 20 * MIN, dayStart)).toBeCloseTo(-0.37 - 20.37, 6);
  });

  it("a missing file is no schedule; an unreadable or malformed one throws (fails closed)", () => {
    expect(readSchedule(null)).toEqual([]);
    expect(readSchedule(join(tmp(), "none.json"))).toEqual([]);
    const bad = join(tmp(), "bad.json");
    writeFileSync(bad, "{nope");
    expect(() => readSchedule(bad)).toThrow(/unreadable/);
    expect(() => readSchedule(schedule([{ at: "x", balance: 1 }]))).toThrow(/malformed entry 0/);
    expect(() => readSchedule(schedule([{ at: iso(T0), balance: 0 }]))).toThrow(/malformed entry 0/);
    expect(readSchedule(schedule([{ at: iso(T0 + MIN), balance: 2 }, { at: iso(T0), balance: 1, dayPnl: -5 }]))).toEqual([{ at: T0, balance: 1, dayPnl: -5 }, { at: T0 + MIN, balance: 2, dayPnl: 0 }]);
  });

  it("the account reads the scheduled balance from its time on, the snapshot and the daily loss limit count the carried day", async () => {
    const file = schedule([{ at: iso(T0 - MIN), day: "2024-03-05", balance: 48700, dayPnl: -600 }]);
    const { call, setNow } = await setup({ now: T0 - 2 * MIN, env: { BACKTESTER_BALANCE_SCHEDULE: file, BACKTESTER_MAX_DAILY_LOSS: "1000" } });
    expect((await call("list_accounts")).data[0].balance).toBe(100000);
    setNow(T0);
    expect((await call("list_accounts")).data[0].balance).toBe(48700);
    await call("place_order", order);
    const snap = (await call("get_account_snapshot", { accountId: 1 })).data;
    expect(snap.account.balance).toBe(48699.63);
    expect(snap.today).toMatchObject({ realizedNetPnL: -600.37, dailyLossLimit: 1000, remainingBeforeLimit: 399.63 });
    // The balance is not part of the public config: nothing shown says it was scheduled.
    expect(JSON.stringify((await call("get_server_config")).data)).not.toMatch(/schedule/i);
  });

  it("a day carried in at the daily loss limit takes no new risk; exits still go", async () => {
    const file = schedule([{ at: iso(T0 - MIN), balance: 49000, dayPnl: -1000 }]);
    const { call } = await setup({ env: { BACKTESTER_BALANCE_SCHEDULE: file, BACKTESTER_MAX_DAILY_LOSS: "1000" } });
    expect((await call("place_order", order)).text).toMatch(/Daily loss limit reached/);
  });

  it("a malformed schedule refuses the account read (never a wrong balance)", async () => {
    const bad = join(tmp(), "bad.json");
    writeFileSync(bad, "[{\"at\": \"never\"}]");
    const { call } = await setup({ env: { BACKTESTER_BALANCE_SCHEDULE: bad } });
    expect((await call("list_accounts")).isError).toBe(true);
  });
});
