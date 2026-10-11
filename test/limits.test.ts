import { describe, expect, it } from "vitest";
import { realizedNet, tradingDayStart } from "../src/risk.js";
import { MIN, RATIONALE, T0, flat, iso, seq, setup, type Row } from "./helpers.js";

// Server-side limits are enforced when an order fills, as a real broker does: placement-time
// checks alone can't be sound, because reduce-only orders (closes, bracket legs) and reducing
// market orders can flatten the position first and turn an accepted opposite order into a new entry.

const base = { accountId: 1, contractId: "BT.MNQ", rationale: RATIONALE };
/** Flat at 20000, then two bars ranging 19980 to 20020. */
const swings = () => ({
  NQ: [...flat(T0 - 30 * MIN, 30, 20000), ...seq(T0, [[20000, 20000, 20000, 20000], [20000, 20020, 19980, 20000], [20000, 20020, 19980, 20000]]), ...flat(T0 + 3 * MIN, 30, 20000)],
});
const net = async (call: any) =>
  (await call("list_open_positions", { accountId: 1 })).data.reduce((n: number, p: any) => n + (p.type === 1 ? 1 : -1) * p.size, 0);
const orders = async (call: any) => (await call("search_orders", { accountId: 1, startTimestamp: iso(T0 - 864e5) })).data;

describe("fill-time limits: the review's repros", () => {
  it("A: a waiting exit flattens first; the opposite stop fills, the limit past the max is rejected", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2", BACKTESTER_MAX_DAILY_LOSS: "0" } });
    await call("place_order", { ...base, side: "buy", type: "market", size: 2 });
    setNow(T0 + 30000);
    for (const o of [
      { side: "sell", type: "market", size: 2 },
      { side: "sell", type: "stop", size: 2, stopPrice: 19990 },
      { side: "sell", type: "limit", size: 2, limitPrice: 20010 },
    ]) expect((await call("place_order", { ...base, ...o })).data.success).toBe(true);
    setNow(T0 + 3 * MIN);
    expect(await net(call)).toBe(-2);
    expect((await orders(call)).find((o: any) => o.id === 4)).toMatchObject({ statusName: "rejected", rejectReason: expect.stringMatching(/would be -4/) });
  });

  it("B: past the daily loss limit, a stop and a target: the second fill would open a short and is rejected", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2", BACKTESTER_MAX_DAILY_LOSS: "1" } });
    await call("place_order", { ...base, side: "buy", type: "market", size: 2 });
    await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 1 }); // -0.50 and fees: past the $1 limit
    setNow(T0 + 30000);
    expect((await call("place_order", { ...base, side: "buy", type: "market", size: 1 })).text).toMatch(/Daily loss limit reached/);
    expect((await call("place_order", { ...base, side: "sell", type: "stop", size: 1, stopPrice: 19990 })).data.success).toBe(true);
    expect((await call("place_order", { ...base, side: "sell", type: "limit", size: 1, limitPrice: 20010 })).data.success).toBe(true);
    setNow(T0 + 3 * MIN);
    expect(await net(call)).toBe(0);
    expect((await orders(call)).find((o: any) => o.type === 1)).toMatchObject({ statusName: "rejected", rejectReason: expect.stringMatching(/daily loss limit/) });
  });

  it("C: a bracket target flattens a short; of two buy stops, the one past the max is rejected", async () => {
    const data = { NQ: [...flat(T0 - 30 * MIN, 30, 20000), ...seq(T0, [[20000, 20000, 20000, 20000], [20000, 20000, 19990, 19995], [19995, 20020, 19995, 20018]]), ...flat(T0 + 3 * MIN, 30, 20018)] };
    const { call, setNow } = await setup({ data, env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2" } });
    for (const o of [
      { side: "sell", type: "market", size: 2, takeProfitBracket: { ticks: 8, type: "limit" } },
      { side: "buy", type: "stop", size: 2, stopPrice: 20010 },
      { side: "buy", type: "stop", size: 2, stopPrice: 20015 },
    ]) expect((await call("place_order", { ...base, ...o })).data.success).toBe(true);
    setNow(T0 + 4 * MIN);
    expect(await net(call)).toBe(2);
    expect((await orders(call)).filter((o: any) => o.statusName === "rejected").map((o: any) => o.stopPrice)).toEqual([20015]);
  });

  it("D: close_position waiting, then a buy: checked against the flat position the close leaves", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "1", BACKTESTER_MAX_ORDER_SIZE: "2" } });
    await call("place_order", { ...base, side: "sell", type: "market", size: 1 });
    setNow(T0 + 30000);
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    // Against the short it would "reduce"; against the flat position the close leaves it opens long 2.
    expect((await call("place_order", { ...base, side: "buy", type: "market", size: 2 })).text).toMatch(/net position to 2/);
    expect((await call("place_order", { ...base, side: "buy", type: "market", size: 1 })).data.success).toBe(true);
    setNow(T0 + 2 * MIN);
    expect(await net(call)).toBe(1); // flattened, then the buy 1
  });
});

describe("closes", () => {
  it("close_position is taken beside a waiting reversing market order, and still ends flat", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2" } });
    await call("place_order", { ...base, side: "sell", type: "market", size: 1 });
    setNow(T0 + 30000);
    expect((await call("place_order", { ...base, side: "buy", type: "market", size: 2 })).data.success).toBe(true);
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    setNow(T0 + 2 * MIN);
    // Arrival order at the next open: the buy (long 1), then the close flattens what is open.
    const fills = (await call("search_trades", { accountId: 1, startTimestamp: iso(T0) })).data;
    expect(fills.slice(1).map((t: any) => [t.orderId, t.sideName, t.size])).toEqual([[2, "buy", 2], [3, "sell", 1]]);
    expect(await net(call)).toBe(0);
  });

  it("close_position flattens an add waiting with it, inside a bar and on a bar's open", async () => {
    for (const at of [T0 + 30000, T0]) {
      const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2" }, now: T0 - 2 * MIN });
      await call("place_order", { ...base, side: "buy", type: "market", size: 1 }); // long 1 (the clock is on a bar's open)
      setNow(at);
      await call("place_order", { ...base, side: "buy", type: "market", size: 1 });
      expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
      setNow(T0 + 2 * MIN);
      expect(await net(call)).toBe(0);
    }
  });

  it("keeps a contract's own fills in order: a buy stop (stops first) fills before the target, which then flattens", async () => {
    const data = { NQ: [...flat(T0 - 30 * MIN, 30, 20000), ...seq(T0, [[20000, 20000, 20000, 20000], [20000, 20010, 20000, 20005]]), ...flat(T0 + 2 * MIN, 30, 20005)] };
    const { call, setNow } = await setup({ data, env: { BACKTESTER_MAX_POSITION_SIZE: "3", BACKTESTER_MAX_ORDER_SIZE: "3", BACKTESTER_SLIPPAGE_TICKS: "0" } });
    await call("place_order", { ...base, side: "buy", type: "market", size: 2, stopLossBracket: { ticks: 40, type: "stop" }, takeProfitBracket: { ticks: 32, type: "limit" } }); // TP sells 2 at 20008
    await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 1 }); // long 1
    await call("place_order", { ...base, side: "buy", type: "stop", size: 1, stopPrice: 20004 });
    setNow(T0 + 3 * MIN);
    // In the bar: the buy stop (long 2), then the target sells 2: flat, nothing left unprotected.
    expect(await net(call)).toBe(0);
    expect((await orders(call)).find((o: any) => o.stopPrice === 20004)).toMatchObject({ statusName: "filled" });
  });

  it("close_position is taken while a partial close waits, and a second one is the same request", async () => {
    const { call, setNow } = await setup({ env: { BACKTESTER_MAX_POSITION_SIZE: "3", BACKTESTER_MAX_ORDER_SIZE: "3" } });
    await call("place_order", { ...base, side: "buy", type: "market", size: 2 });
    setNow(T0 + 30000);
    expect((await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 1 })).data.success).toBe(true);
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true); // idempotent
    expect((await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 1 })).data).toMatchObject({ errorName: "OrderPending", errorMessage: expect.stringMatching(/close_position is already waiting/) });
    expect((await call("list_open_orders", { accountId: 1 })).data).toHaveLength(2); // the partial and one close
    setNow(T0 + 2 * MIN);
    expect(await net(call)).toBe(0);
    expect((await call("search_trades", { accountId: 1, startTimestamp: iso(T0) })).data.slice(1).map((t: any) => t.size)).toEqual([1, 1]);
  });

  it("an order that only reduces gets no bracket legs; one going through flat gets them for the new part", async () => {
    const { call } = await setup({ env: { BACKTESTER_MAX_POSITION_SIZE: "3", BACKTESTER_MAX_ORDER_SIZE: "3" } });
    await call("place_order", { ...base, side: "buy", type: "market", size: 3 });
    await call("place_order", { ...base, side: "sell", type: "market", size: 2, takeProfitBracket: { ticks: 8, type: "limit" } }); // long 3 -> 1: only reduces
    expect((await call("list_open_orders", { accountId: 1 })).data).toEqual([]);
    await call("place_order", { ...base, side: "buy", type: "market", size: 1 }); // long 2
    await call("place_order", { ...base, side: "sell", type: "market", size: 3, stopLossBracket: { ticks: 8, type: "stop" } }); // long 2 -> short 1
    expect((await call("list_open_orders", { accountId: 1 })).data).toMatchObject([{ sideName: "buy", typeName: "stop", size: 1 }]);
  });

  it("a reducing market order isn't refused for the opposite orders resting beside it", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "1", BACKTESTER_MAX_DAILY_LOSS: "1" } });
    await call("place_order", { ...base, side: "buy", type: "market", size: 1 });
    await call("place_order", { ...base, side: "sell", type: "limit", size: 1, limitPrice: 20030 });
    await call("place_order", { ...base, side: "sell", type: "stop", size: 1, stopPrice: 19970 });
    await call("place_order", { ...base, contractId: "BT.NQ", side: "buy", type: "market", size: 1 });
    await call("partial_close_position", { accountId: 1, contractId: "BT.NQ", size: 1 }); // past the daily loss limit
    setNow(T0 + 30000);
    expect((await call("place_order", { ...base, side: "sell", type: "market", size: 1 })).data.success).toBe(true);
  });
});

describe("close_position means flat after everything sent before it", () => {
  const env = { BACKTESTER_MAX_POSITION_SIZE: "3", BACKTESTER_MAX_ORDER_SIZE: "3" };
  it.each([
    ["an add", "buy", 1],
    ["a reversal", "sell", 2],
  ])("a second close after %s sent between the two ends flat", async (_n, side, size) => {
    const { call, setNow } = await setup({ data: swings(), env, now: T0 - 2 * MIN });
    await call("place_order", { ...base, side: "buy", type: "market", size: 1 }); // long 1
    setNow(T0 + 30000);
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    expect((await call("place_order", { ...base, side, type: "market", size })).data.success).toBe(true);
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true); // nothing new since: no-op
    const closes = (await call("search_orders", { accountId: 1, startTimestamp: iso(T0 - 864e5) })).data.filter((o: any) => o.reduceOnly);
    expect(closes.map((o: any) => o.statusName)).toEqual(["cancelled", "open"]); // the close moved after the later order
    setNow(T0 + 2 * MIN);
    expect(await net(call)).toBe(0);
  });

  it("a waiting close isn't cancelled when another fill flattens first; it flattens the add sent before it", async () => {
    const { call, setNow } = await setup({ data: swings(), env, now: T0 - 2 * MIN });
    await call("place_order", { ...base, side: "buy", type: "market", size: 1 }); // long 1
    setNow(T0 - 30000);
    await call("place_order", { ...base, side: "sell", type: "market", size: 1 }); // flattens first at T0's open
    await call("place_order", { ...base, side: "buy", type: "market", size: 1 }); // reopens long 1
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    setNow(T0 + MIN);
    expect(await net(call)).toBe(0);
  });

  it("checks new orders against the flat the close leaves plus market orders sent after it", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2" }, now: T0 - 2 * MIN });
    await call("place_order", { ...base, side: "buy", type: "market", size: 1 }); // long 1
    setNow(T0 - 30000);
    await call("place_order", { ...base, side: "buy", type: "market", size: 1 }); // sent before the close: flattened
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    expect((await call("place_order", { ...base, side: "buy", type: "market", size: 2 })).data.success).toBe(true); // 0 + 2
    expect((await call("place_order", { ...base, side: "buy", type: "market", size: 1 })).text).toMatch(/net position to 3/);
    setNow(T0 + MIN);
    expect(await net(call)).toBe(2);
  });

  it("a partial close while a close waits reduces what was sent after it", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2" }, now: T0 - 2 * MIN });
    await call("place_order", { ...base, side: "buy", type: "market", size: 1 }); // long 1
    setNow(T0 - 30000);
    expect((await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 1 })).data.success).toBe(true);
    await call("cancel_order", { accountId: 1, orderId: 2 });
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    expect((await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 1 })).data).toMatchObject({ errorName: "OrderPending", errorMessage: expect.stringMatching(/nothing sent after it/) });
    await call("place_order", { ...base, side: "buy", type: "market", size: 2 }); // long 2 after the close
    expect((await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 3 })).data).toMatchObject({ errorName: "InvalidCloseSize", errorMessage: expect.stringMatching(/left after the waiting close_position \(2\)/) });
    expect((await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 1 })).data.success).toBe(true);
    expect((await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 2 })).data).toMatchObject({ errorName: "OrderPending" });
    setNow(T0 + MIN);
    expect(await net(call)).toBe(1); // flat, long 2, then the partial sells 1
  });

  it("only market orders sent after a waiting close count as reopening it, not resting ones", async () => {
    const { call, setNow } = await setup({ data: swings(), env, now: T0 - 2 * MIN });
    await call("place_order", { ...base, side: "buy", type: "market", size: 1 }); // long 1
    setNow(T0 - 30000);
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    await call("place_order", { ...base, side: "buy", type: "limit", size: 1, limitPrice: 19900 }); // resting: may never fill
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true); // still a no-op
    expect((await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 1 })).data).toMatchObject({ errorName: "OrderPending" });
    const closes = (await orders(call)).filter((o: any) => o.reduceOnly);
    expect(closes.map((o: any) => o.statusName)).toEqual(["open"]);
  });

  it("a sell placed after a waiting close is an opening order (limits and the daily loss apply)", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { ...env, BACKTESTER_MAX_DAILY_LOSS: "1" } });
    await call("place_order", { ...base, side: "buy", type: "market", size: 2 });
    await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 1 }); // past the daily loss limit, long 1
    setNow(T0 + 30000);
    expect((await call("place_order", { ...base, side: "sell", type: "market", size: 1 })).data.success).toBe(true); // reduces: allowed
    await call("cancel_order", { accountId: 1, orderId: 3 });
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    expect((await call("place_order", { ...base, side: "sell", type: "market", size: 1 })).text).toMatch(/Daily loss limit reached/);
  });
});

// ── Cross-contract sync: every contract's bars, exits before opens, opens before closes ──────

describe("several contracts in one minute", () => {
  // NQ rises through minute T0+1; ES falls 20 points in it.
  const two = () => ({
    NQ: [...flat(T0 - 30 * MIN, 30, 20000), ...seq(T0, [[20000, 20000, 20000, 20000], [20000, 20020, 20000, 20010]]), ...flat(T0 + 2 * MIN, 30, 20010)],
    ES: [...flat(T0 - 30 * MIN, 30, 5000), ...seq(T0, [[5000, 5000, 5000, 5000], [5000, 5000, 4980, 4985]]), ...flat(T0 + 2 * MIN, 30, 4985)],
  });
  const env = { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2", BACKTESTER_MAX_DAILY_LOSS: "5", BACKTESTER_SLIPPAGE_TICKS: "0" };
  const statusOf = async (call: any, cid: string) => (await orders(call)).filter((o: any) => o.contractId === cid && o.typeName === "stop" && !o.reduceOnly)[0]?.statusName;

  it.each([
    ["BT.MES", "BT.MNQ"], // the loss's contract sorts first
    ["BT.ES", "BT.MNQ"],
  ])("a stop-out on %s counts before an entry on %s in the same minute", async (loser, entry) => {
    const { call, setNow } = await setup({ data: two(), env });
    await call("place_order", { ...base, contractId: loser, side: "buy", type: "market", size: 1, stopLossBracket: { ticks: 40, type: "stop" } }); // ES stop 4990: -$12.50 (MES) / -$125 (ES)
    expect((await call("place_order", { ...base, contractId: entry, side: "buy", type: "stop", size: 1, stopPrice: 20005 })).data.success).toBe(true);
    setNow(T0 + 3 * MIN);
    expect(await statusOf(call, entry)).toBe("rejected");
  });

  it("the same when the entry's contract sorts first", async () => {
    // NQ falls (a long MNQ is stopped out), ES rises (a buy stop entry on ES triggers) in the same minute.
    const data = {
      NQ: [...flat(T0 - 30 * MIN, 30, 20000), ...seq(T0, [[20000, 20000, 20000, 20000], [20000, 20000, 19950, 19960]]), ...flat(T0 + 2 * MIN, 30, 19960)],
      ES: [...flat(T0 - 30 * MIN, 30, 5000), ...seq(T0, [[5000, 5000, 5000, 5000], [5000, 5020, 5000, 5010]]), ...flat(T0 + 2 * MIN, 30, 5010)],
    };
    const { call, setNow } = await setup({ data, env });
    await call("place_order", { ...base, contractId: "BT.MNQ", side: "buy", type: "market", size: 1, stopLossBracket: { ticks: 40, type: "stop" } }); // stop 19990: -$5
    expect((await call("place_order", { ...base, contractId: "BT.ES", side: "buy", type: "stop", size: 1, stopPrice: 5005 })).data.success).toBe(true);
    setNow(T0 + 3 * MIN);
    expect(await statusOf(call, "BT.ES")).toBe("rejected");
    expect(await net(call)).toBe(0);
  });

  it("at a minute's open too: a loss closing on one contract counts before a reversal on another that sorts first", async () => {
    const data = {
      NQ: [...flat(T0 - 30 * MIN, 30, 20000), [T0, 20000, 20000, 20000, 20000] as Row, ...flat(T0 + MIN, 30, 19990)],
      ES: [...flat(T0 - 30 * MIN, 31, 5000), ...flat(T0 + MIN, 30, 5000)],
    };
    const { call, setNow } = await setup({ data, env: { ...env, BACKTESTER_SLIPPAGE_TICKS: "1" } });
    await call("place_order", { ...base, contractId: "BT.MES", side: "buy", type: "market", size: 1 });
    await call("place_order", { ...base, contractId: "BT.MNQ", side: "buy", type: "market", size: 1 });
    setNow(T0 + 30000);
    expect((await call("place_order", { ...base, contractId: "BT.MES", side: "sell", type: "market", size: 2 })).data.success).toBe(true); // through flat
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true); // -$21 at the next open
    setNow(T0 + 2 * MIN);
    expect((await orders(call)).find((o: any) => o.contractId === "BT.MES" && o.size === 2)).toMatchObject({ statusName: "rejected", rejectReason: expect.stringMatching(/daily loss/) });
  });

  it("a client's reducing market order at a loss counts before another contract's entry at the same open", async () => {
    const data = {
      NQ: [...flat(T0 - 30 * MIN, 30, 20000), [T0, 20000, 20000, 20000, 20000] as Row, ...flat(T0 + MIN, 30, 19990)],
      ES: [...flat(T0 - 30 * MIN, 31, 5000), ...flat(T0 + MIN, 30, 5000)],
    };
    const { call, setNow } = await setup({ data, env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2", BACKTESTER_MAX_DAILY_LOSS: "10", BACKTESTER_SLIPPAGE_TICKS: "1" } });
    await call("place_order", { ...base, contractId: "BT.MNQ", side: "buy", type: "market", size: 1 });
    setNow(T0 + 30000);
    await call("place_order", { ...base, contractId: "BT.MES", side: "buy", type: "market", size: 1 });
    expect((await call("place_order", { ...base, contractId: "BT.MNQ", side: "sell", type: "market", size: 1 })).data.success).toBe(true);
    setNow(T0 + 2 * MIN);
    expect((await orders(call)).find((o: any) => o.contractId === "BT.MES")).toMatchObject({ statusName: "rejected" });
  });

  it("fills every contract's orders in a minute, at its open and at its close", async () => {
    const { call, setNow } = await setup({ data: two(), env: { ...env, BACKTESTER_MAX_DAILY_LOSS: "0" } });
    setNow(T0 + 30000);
    await call("place_order", { ...base, contractId: "BT.MES", side: "sell", type: "market", size: 1 });
    await call("place_order", { ...base, contractId: "BT.MNQ", side: "buy", type: "market", size: 1 });
    await call("place_order", { ...base, contractId: "BT.MES", side: "buy", type: "limit", size: 1, limitPrice: 4990 });
    await call("place_order", { ...base, contractId: "BT.MNQ", side: "sell", type: "limit", size: 1, limitPrice: 20015 });
    setNow(T0 + 2 * MIN);
    const fills = (await call("search_trades", { accountId: 1, startTimestamp: iso(T0) })).data;
    expect(fills.map((t: any) => [t.contractId, t.creationTimestamp])).toEqual([
      ["BT.MES", iso(T0 + MIN)], ["BT.MNQ", iso(T0 + MIN)], ["BT.MES", iso(T0 + 2 * MIN)], ["BT.MNQ", iso(T0 + 2 * MIN)],
    ]);
  });

  it("all opens of a minute come before any of its closes: a loss at the close doesn't stop an entry at the open", async () => {
    const { call, setNow } = await setup({ data: two(), env });
    await call("place_order", { ...base, contractId: "BT.MES", side: "buy", type: "market", size: 1, stopLossBracket: { ticks: 40, type: "stop" } });
    setNow(T0 + 30000);
    expect((await call("place_order", { ...base, contractId: "BT.MNQ", side: "buy", type: "market", size: 1 })).data.success).toBe(true);
    setNow(T0 + 2 * MIN);
    expect((await orders(call)).find((o: any) => o.contractId === "BT.MNQ")).toMatchObject({ statusName: "filled" });
  });

  it("rejects an opening fill once realized loss equals the limit exactly", async () => {
    const data = { NQ: [...flat(T0 - 30 * MIN, 30, 20000), ...seq(T0, [[20000, 20000, 20000, 20000], [20000, 20003, 19998, 20003]]), ...flat(T0 + 2 * MIN, 30, 20003)] };
    const { call, setNow } = await setup({ data, env: { BACKTESTER_MAX_DAILY_LOSS: "2", BACKTESTER_SLIPPAGE_TICKS: "0", BACKTESTER_FEES_MICRO: "0", BACKTESTER_FEES_MINI: "0" } });
    await call("place_order", { ...base, side: "buy", type: "market", size: 1, stopLossBracket: { ticks: 4, type: "stop" } }); // stop 19999: exactly -$2
    expect((await call("place_order", { ...base, side: "buy", type: "stop", size: 1, stopPrice: 20002 })).data.success).toBe(true);
    setNow(T0 + 3 * MIN);
    expect((await call("search_trades", { accountId: 1, startTimestamp: iso(T0) })).data.at(-1)).toMatchObject({ profitAndLoss: -2 });
    expect((await orders(call)).find((o: any) => o.stopPrice === 20002 && !o.reduceOnly)).toMatchObject({ statusName: "rejected" });
  });
});

describe("trailing stops in the sync", () => {
  // T0+1 rises to 20010 but dips to 19995 first; T0+2 opens 20002 and dips to 19998.
  const data = () => ({ NQ: [...flat(T0 - 30 * MIN, 30, 20000), ...seq(T0, [[20000, 20000, 20000, 20000], [20000, 20010, 19995, 20008], [20002, 20003, 19998, 20000]]), ...flat(T0 + 3 * MIN, 30, 20000)] });
  const env = { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2" };

  it.each([
    ["protecting a long", true],
    ["opening a short", false],
  ])("ratchet once per bar, after its fills: never triggered on the bar that moved them (%s)", async (_name, long) => {
    const { call, setNow } = await setup({ data: data(), env });
    if (long) await call("place_order", { ...base, side: "buy", type: "market", size: 1 });
    await call("place_order", { ...base, side: "sell", type: "trailing_stop", size: 1, trailPrice: 19990 }); // 10 points under the last close
    setNow(T0 + 2 * MIN);
    const stop = (await orders(call)).find((o: any) => o.typeName === "trailing_stop");
    expect(stop).toMatchObject({ statusName: "open", stopPrice: 20000 }); // moved by T0+1's high, not filled on it
    setNow(T0 + 3 * MIN);
    expect((await orders(call)).find((o: any) => o.typeName === "trailing_stop")).toMatchObject({ statusName: "filled", filledPrice: 19999.75 });
    expect(await net(call)).toBe(long ? 0 : -1);
  });
});

// ── Property test: a bounded, seeded fuzz of random order flow ────────────────

function rng(seed: number) {
  let s = seed;
  const next = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
  return { next, int: (a: number, b: number) => a + Math.floor(next() * (b - a + 1)), pick: <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)] };
}

describe("property: limits hold under random order flow", () => {
  it("never exceeds the max position, and opens no exposure past the daily loss limit (seeded)", async () => {
    const r = rng(20241005);
    let steps = 0;
    const violations: string[] = [];
    for (let e = 0; e < 40; e++) {
      const maxPos = r.int(1, 3);
      const maxOrd = r.int(1, 3);
      const dl = r.pick([0, 3, 10, 30]);
      const rows: Row[] = [];
      let p = 20000;
      for (let i = -30; i < 150; i++) {
        const o = p;
        const c = o + r.int(-8, 8) * 0.25;
        rows.push([T0 + i * MIN, o, Math.max(o, c) + r.int(0, 6) * 0.25, Math.min(o, c) - r.int(0, 6) * 0.25, c]);
        p = c;
      }
      const { call, setNow, exchange } = await setup({
        data: { NQ: rows },
        env: { BACKTESTER_MAX_POSITION_SIZE: String(maxPos), BACKTESTER_MAX_ORDER_SIZE: String(maxOrd), BACKTESTER_MAX_DAILY_LOSS: String(dl), BACKTESTER_END: iso(T0 + 100 * MIN) },
      });
      let now = T0;
      const last = () => rows[rows.findLastIndex((x) => x[0] + MIN <= now)][4];
      for (let k = 0; k < 50; k++) {
        steps++;
        const open = exchange.openOrders(1);
        const a = r.next();
        const L = last();
        if (a < 0.38) {
          const type = r.pick(["market", "limit", "stop", "join_bid", "trailing_stop", "market", "limit", "stop"]);
          const side = r.pick(["buy", "sell"]);
          const off = r.int(1, 12) * 0.25;
          const args: Record<string, unknown> = { ...base, side, type, size: r.int(1, maxOrd + 1) };
          if (type === "limit") args.limitPrice = r.next() < 0.2 ? (side === "buy" ? L + off : L - off) : side === "buy" ? L - off : L + off;
          if (type === "stop") args.stopPrice = side === "buy" ? L + off : L - off;
          if (type === "trailing_stop") args.trailPrice = side === "buy" ? L + off : L - off;
          if (r.next() < 0.25) args.stopLossBracket = { ticks: r.int(2, 10), type: "stop" };
          if (r.next() < 0.25) args.takeProfitBracket = { ticks: r.int(2, 10), type: "limit" };
          await call("place_order", args);
        } else if (a < 0.55 && open.length) {
          const o = r.pick(open);
          const args: Record<string, unknown> = { accountId: 1, orderId: o.id };
          if (r.next() < 0.6 || (o.type !== 1 && o.type !== 4)) args.size = r.int(1, maxOrd + 1);
          else if (o.type === 1) args.limitPrice = L + r.int(-12, 12) * 0.25;
          else args.stopPrice = L + r.int(-12, 12) * 0.25;
          await call("modify_order", args);
        } else if (a < 0.65 && open.length) {
          await call("cancel_order", { accountId: 1, orderId: r.pick(open).id });
        } else if (a < 0.72) {
          await call("close_position", { accountId: 1, contractId: "BT.MNQ" });
        } else if (a < 0.76) {
          await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: r.int(1, 3) });
        } else {
          now = Math.min(now + r.pick([0, 15000, 30000, 59999, MIN, MIN, 2 * MIN, 3 * MIN, MIN + 30000]), T0 + 140 * MIN);
          setNow(now);
          exchange.openOrders(1);
        }
      }
      setNow(T0 + 140 * MIN);
      exchange.openOrders(1);
      // Replay the fills: |net| within the max after every fill; past the daily loss limit, no fill opens exposure.
      const reduceOnly = new Set(exchange.searchOrders(1, iso(0)).filter((o) => o.reduceOnly).map((o) => o.id));
      let n = 0;
      const trades = exchange.trades(1, iso(0));
      trades.forEach((t, i) => {
        const before = n;
        n += (t.side === 0 ? 1 : -1) * t.size;
        const opens = Math.abs(n) > Math.abs(before) || (before !== 0 && n !== 0 && Math.sign(n) !== Math.sign(before));
        if (Math.abs(n) > maxPos) violations.push(`episode ${e}: net ${n} > max ${maxPos} after trade ${t.id}`);
        if (opens && reduceOnly.has(t.orderId)) violations.push(`episode ${e}: reduce-only order ${t.orderId} opened exposure`);
        const dayStart = tradingDayStart(new Date(t.creationTimestamp)).getTime();
        const realized = realizedNet(trades.slice(0, i).filter((x) => Date.parse(x.creationTimestamp) >= dayStart));
        if (dl > 0 && opens && realized <= -dl) violations.push(`episode ${e}: trade ${t.id} opened exposure at realized ${realized.toFixed(2)} (limit -${dl})`);
      });
    }
    expect(steps).toBe(2000);
    expect(violations).toEqual([]);
  }, 60000);
});
