import { describe, expect, it } from "vitest";
import { MIN, RATIONALE, T0, iso, seq, setup, tmp, type Row } from "./helpers.js";

/** 60 one-minute bars from 14:30Z on each date, prices from `price(day, i)`. */
function sessions(dates: string[], price: (day: number, i: number) => number): Row[] {
  return dates.flatMap((d, day) => {
    const start = Date.parse(`${d}T14:30:00Z`);
    return Array.from({ length: 60 }, (_, i) => {
      const p = price(day, i);
      return [start + i * MIN, p, p + 0.5, p - 0.5, p] as Row;
    });
  });
}

describe("harness flow: entry with a stop bracket, position, stop moved, exit, fills", () => {
  it("stops out at the moved stop as the clock advances", async () => {
    // Up 4 points over 4 bars, then down through the entry.
    const path = [20000, 20001, 20002, 20003, 20004, 20002, 19999, 19998];
    const { call, setNow } = await setup({ data: { NQ: seq(T0 - 5 * MIN, [...Array(5).fill([20000, 20000, 20000, 20000]), ...path.map((p) => [p, p + 0.5, p - 0.5, p] as [number, number, number, number])]) } });

    expect((await call("get_server_config")).data.tradingEnabled).toBe(true);
    const [acct] = (await call("list_accounts")).data;
    const [mnq] = (await call("search_contracts", { searchText: "MNQ" })).data;
    const placed = await call("place_order", {
      accountId: acct.id, contractId: mnq.id, side: "buy", type: "market", size: 1,
      stopLossBracket: { ticks: 20, type: "stop" }, customTag: "fth-gw-1", rationale: RATIONALE,
    });
    expect(placed.data).toMatchObject({ success: true, orderId: 1 });
    expect((await call("search_orders", { accountId: 1, startTimestamp: iso(T0 - 864e5) })).data.find((o: any) => o.customTag === "fth-gw-1")).toMatchObject({ id: 1, statusName: "filled" });

    const [pos] = (await call("list_open_positions", { accountId: 1 })).data;
    expect(pos).toMatchObject({ contractId: "BT.MNQ", direction: "long", size: 1, averagePrice: 20000.25, creationTimestamp: iso(T0) });
    const [stop] = (await call("list_open_orders", { accountId: 1 })).data;
    expect(stop).toMatchObject({ typeName: "stop", sideName: "sell", size: 1, stopPrice: 19995.25 });

    setNow(T0 + 4 * MIN); // four bars up
    expect((await call("list_open_positions", { accountId: 1 })).data).toHaveLength(1);
    expect((await call("modify_order", { accountId: 1, orderId: stop.id, stopPrice: 20000.25, reason: "stop to breakeven" })).data.success).toBe(true);

    for (let m = 5; m <= 8; m++) setNow(T0 + m * MIN);
    expect((await call("list_open_positions", { accountId: 1 })).data).toEqual([]);
    expect((await call("list_open_orders", { accountId: 1 })).data).toEqual([]);
    const fills = (await call("search_trades", { accountId: 1 })).data;
    // The 20002 bar's low (20001.5) stays above the stop; the 19999 bar opens below it: gap fill at the open less a tick.
    expect(fills.map((f: any) => [f.sideName, f.price, f.profitAndLoss, f.fees, f.creationTimestamp])).toEqual([
      ["buy", 20000.25, null, 0.37, iso(T0)],
      ["sell", 19998.75, -3, 0.37, iso(T0 + 7 * MIN)],
    ]);
    expect((await call("get_account_snapshot", { accountId: 1 })).data.account.balance).toBe(100000 - 3 - 0.74);
  });

  it("closes at market with close_position and leaves no bracket behind", async () => {
    const { call, setNow } = await setup();
    await call("place_order", { accountId: 1, contractId: "BT.MNQ", side: "sell", type: "market", size: 1, stopLossBracket: { ticks: 20, type: "stop" }, takeProfitBracket: { ticks: 40, type: "limit" }, rationale: RATIONALE });
    setNow(T0 + 3 * MIN);
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ", reason: "time stop" })).data.success).toBe(true);
    expect((await call("list_open_positions", { accountId: 1 })).data).toEqual([]);
    expect((await call("list_open_orders", { accountId: 1 })).data).toEqual([]);
    const fills = (await call("search_trades", { accountId: 1 })).data;
    expect(fills.map((f: any) => [f.sideName, f.price, f.profitAndLoss])).toEqual([["sell", 19999.75, null], ["buy", 20000.25, -1]]);
  });
});

describe("replay across days", () => {
  const dates = ["2024-03-05", "2024-03-06", "2024-03-07"];
  // Day 0 falls 20 points after the first 10 minutes; days 1 and 2 are flat.
  const data = { NQ: sessions(dates, (day, i) => (day === 0 && i >= 10 ? 19980 : 20000)) };
  const env = { BACKTESTER_MAX_DAILY_LOSS: "100", BACKTESTER_MAX_ORDER_SIZE: "2", BACKTESTER_MAX_POSITION_SIZE: "2" };
  const at = (d: string, hhmm: string) => Date.parse(`${d}T${hhmm}:00Z`);
  const nq = { accountId: 1, contractId: "BT.NQ", type: "market", size: 1, rationale: RATIONALE };

  it("resets the daily loss limit at 17:00 CT and carries the balance", async () => {
    const { call, setNow } = await setup({ data, env, now: at(dates[0], "14:35") });
    await call("place_order", { ...nq, side: "buy" });
    setNow(at(dates[0], "14:45")); // the drop: 20 points x $20 on NQ
    await call("close_position", { accountId: 1, contractId: "BT.NQ" });
    const day0 = (await call("get_account_snapshot", { accountId: 1 })).data;
    expect(day0.today).toMatchObject({ tradingDayStartedAt: "2024-03-04T23:00:00.000Z", realizedNetPnL: -412.8, remainingBeforeLimit: -312.8 });
    expect((await call("place_order", { ...nq, side: "buy" })).text).toMatch(/Daily loss limit reached/);

    setNow(at(dates[1], "14:35"));
    const day1 = (await call("get_account_snapshot", { accountId: 1 })).data;
    expect(day1.today).toMatchObject({ tradingDayStartedAt: "2024-03-05T23:00:00.000Z", realizedNetPnL: 0, fills: 0 });
    expect(day1.account.balance).toBe(100000 - 412.8);
    expect((await call("place_order", { ...nq, side: "buy" })).data.success).toBe(true);
    // A past startTimestamp is honoured.
    expect((await call("search_trades", { accountId: 1, startTimestamp: "2024-03-04T23:00:00Z" })).data).toHaveLength(3);
  });

  it("holds a position overnight and settles its bracket on a later day", async () => {
    const { call, setNow } = await setup({ data, env, now: at(dates[1], "14:35") });
    await call("place_order", { ...nq, side: "sell", takeProfitBracket: { ticks: 4, type: "limit" } });
    setNow(at(dates[2], "15:30"));
    expect((await call("list_open_positions", { accountId: 1 })).data).toHaveLength(1); // flat days: target 1 point away never reached
    const daily = (await call("get_bars", { contractId: "BT.NQ", unit: "day", unitNumber: 1, limit: 10 })).data;
    expect(daily.bars.map((b: any) => b.t)).toEqual(["2024-03-04T23:00:00.000Z", "2024-03-05T23:00:00.000Z"]);
    const partial = (await call("get_bars", { contractId: "BT.NQ", unit: "day", unitNumber: 1, limit: 10, includePartialBar: true })).data;
    expect(partial.count).toBe(3);
  });
});

describe("replay window", () => {
  const data = { NQ: [...seq(T0 - 120 * MIN, Array(240).fill([20000, 20000, 20000, 20000]))] };

  it("keeps bars before START as lookback, starts the account at START, and stops at END", async () => {
    const start = iso(T0);
    const end = iso(T0 + 30 * MIN);
    const { call, setNow } = await setup({ data, now: T0 - 30 * MIN, env: { BACKTESTER_START: start, BACKTESTER_END: end } });
    expect((await call("get_bars", { contractId: "BT.NQ", unit: "minute", unitNumber: 1, limit: 20000 })).data.count).toBe(90);
    expect((await call("place_order", { accountId: 1, contractId: "BT.MNQ", side: "buy", type: "market", size: 1, rationale: RATIONALE })).text).toMatch(/before BACKTESTER_START/);
    expect((await call("list_accounts")).data[0].balance).toBe(100000);

    setNow(T0);
    expect((await call("place_order", { accountId: 1, contractId: "BT.MNQ", side: "buy", type: "market", size: 1, rationale: RATIONALE })).data.success).toBe(true);
    expect((await call("place_order", { accountId: 1, contractId: "BT.MNQ", side: "sell", type: "limit", size: 1, limitPrice: 20100, rationale: RATIONALE })).data.success).toBe(true);

    setNow(T0 + 90 * MIN); // past END
    const bars = (await call("get_bars", { contractId: "BT.NQ", unit: "minute", unitNumber: 1, limit: 1 })).data.bars;
    expect(bars[0].t).toBe(iso(T0 + 29 * MIN)); // capped at END
    // Adding risk is refused after END; flattening and cancelling still work, at the last close (the backtester's "end").
    expect((await call("place_order", { accountId: 1, contractId: "BT.MNQ", side: "buy", type: "market", size: 1, rationale: RATIONALE })).text).toMatch(/after BACKTESTER_END/);
    // close_position flattens at the last close, then cancels what still works on the contract (the sell limit).
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data).toMatchObject({ status: "flat", success: true, cancelledOrderIds: [2], remainingOrderIds: [] });
    expect((await call("list_open_positions", { accountId: 1 })).data).toEqual([]);
    expect((await call("search_trades", { accountId: 1 })).data.at(-1)).toMatchObject({ sideName: "sell", price: 20000, profitAndLoss: -0.5, creationTimestamp: end });
    expect((await call("list_open_orders", { accountId: 1 })).data).toHaveLength(0);
    expect((await call("cancel_order", { accountId: 1, orderId: 2 })).data).toMatchObject({ success: false, errorName: "OrderNotFound" });
    expect((await call("get_quote", { contractId: "BT.NQ" })).data.quote.lastUpdated).toBe(end);
  });
});

describe("run isolation and determinism", () => {
  const data = { NQ: seq(T0 - 5 * MIN, Array.from({ length: 40 }, (_, i) => { const p = 20000 + (i % 7) - 3; return [p, p + 1, p - 1, p] as [number, number, number, number]; })) };

  async function run(dir: string, runId: string) {
    const s = await setup({ dir, data, now: T0, env: { BACKTESTER_RUN_ID: runId, BACKTESTER_STATE_DIR: `${dir}/runs/${runId}` } });
    await s.call("place_order", { accountId: 1, contractId: "BT.MNQ", side: "buy", type: "market", size: 1, stopLossBracket: { ticks: 6, type: "stop" }, takeProfitBracket: { ticks: 8, type: "limit" }, rationale: RATIONALE });
    for (let m = 1; m <= 30; m += 3) s.setNow(T0 + m * MIN);
    await s.call("place_order", { accountId: 1, contractId: "BT.MNQ", side: "sell", type: "market", size: 1, stopLossBracket: { ticks: 6, type: "stop" }, rationale: RATIONALE });
    s.setNow(T0 + 34 * MIN);
    return { trades: (await s.call("search_trades", { accountId: 1, startTimestamp: iso(T0 - 864e5) })).data, journal: s.config.journalPath, state: s.config.statePath };
  }

  it("gives the same fills for the same data, window, clock sequence and orders, in separate state", async () => {
    const a = await run(tmp(), "a");
    const b = await run(tmp(), "b");
    expect(a.trades.length).toBeGreaterThan(2);
    expect(b.trades).toEqual(a.trades);
    expect(a.state).not.toBe(b.state);
    expect(a.journal).toMatch(/runs\/a\/journal\.jsonl$/);
  });
});
