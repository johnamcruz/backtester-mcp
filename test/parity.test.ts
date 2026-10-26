import { describe, expect, it } from "vitest";
import { MIN, RATIONALE, T0, flat, setup } from "./helpers.js";

/**
 * Order-handling parity with projectx-mcp (the live reference). Every expected object, message and
 * field list below is copied from projectx-mcp's src/server.ts, src/protect.ts and
 * test/server.test.ts, so drift in either repository fails here. Ids, prices and the contract id
 * are the replay's own; everything else must match.
 */

// ── projectx-mcp's result shapes ─────────────────────────────────────

/** place_order's result fields (projectx-mcp placeOrder: { orderId, customTag, ...outcome }). */
const PX_PLACE_FIELDS = { orderId: "number|null", customTag: "string", success: "boolean", errorCode: "number", errorName: "string", errorMessage: "string|null" };
/** The `protection` object (projectx-mcp protect.ts Protection; `flatten` only after a flatten). */
const PX_PROTECTION_FIELDS = { status: "string", stopOrderId: "number|null", filledSize: "number|null", fillPrice: "number|null", targetPlaced: "boolean", message: "string" };
/** close_position's result (projectx-mcp server.ts close_position). */
const PX_CLOSE_FIELDS = { status: "string", success: "boolean", close: "object", positionNet: "number|null", positionSize: "number|null", cancelledOrderIds: "array", remainingOrderIds: "array|null" };
const PX_CLOSE_OUTCOME_FIELDS = { success: "boolean", errorCode: "number", errorName: "string", errorMessage: "string|null" };
/** The flatten result inside protection (projectx-mcp FlattenResult). */
const PX_FLATTEN_FIELDS = { status: "string", close: "object", positionNet: "number|null", positionSize: "number|null", cancelledOrderIds: "array", failedCancelOrderIds: "array", remainingOrderIds: "array|null" };
const PX_STATUSES = ["protected", "flattened_stop_unconfirmed", "pending_fill", "not_filled", "unknown"];
const PX_FLAT_STATUSES = ["flat", "still_open", "legs_left"];

const PX_MESSAGES = {
  protected: "The entry filled and its stop is working.",
  pendingFill: "Resting entry: its bracket legs attach when it fills.",
  notFilledInTime: "The market entry was not filled within the check window, so the server cancelled it; this entry opened nothing, and any earlier position is unchanged.",
  flattened: (contractId: string) => `The entry filled but its stop leg was not confirmed in time, so the server closed the position and cancelled its orders. The account is flat on ${contractId}.`,
  bracketMin: (label: string, n: number) => `Blocked by risk guardrail: ${label} is ${n} ticks; the minimum bracket distance is 4 ticks.`,
  canTrade: (name: string) => `Blocked by risk guardrail: account ${name} has canTrade=false (locked by the firm); only orders that reduce a position are allowed.`,
};

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
/** Every projectx-mcp field is present with one of its types (extra fields are allowed). */
function expectShape(obj: Record<string, unknown>, fields: Record<string, string>) {
  for (const [k, types] of Object.entries(fields)) {
    expect(Object.keys(obj), k).toContain(k);
    expect(types.split("|"), `${k}: ${typeOf(obj[k])}`).toContain(typeOf(obj[k]));
  }
}

const MNQ = "BT.MNQ";
const order = { accountId: 1, contractId: MNQ, side: "buy", type: "market", size: 1, rationale: RATIONALE };
const bracketed = { ...order, stopLossBracket: { ticks: 10, type: "stop" }, takeProfitBracket: { ticks: 20, type: "limit" } };
/** NQ flat at 20000, with no bar in the minute at T0 (a minute without trades). */
const gap = () => ({ NQ: [...flat(T0 - 60 * MIN, 60, 20000), ...flat(T0 + MIN, 60, 20000)] });

describe("1. place_order brackets", () => {
  it.each([
    [{ stopLossBracket: { ticks: 3, type: "stop" } }, "stopLossBracket", 3],
    [{ stopLossBracket: { ticks: -3, type: "stop" } }, "stopLossBracket", 3],
    [{ takeProfitBracket: { ticks: 3, type: "limit" } }, "takeProfitBracket", 3],
  ])("refuses a bracket under 4 ticks before sending (%o)", async (patch, label, n) => {
    const { call, journal } = await setup();
    const res = await call("place_order", { ...order, ...patch });
    expect(res.isError).toBe(true);
    expect(res.text).toBe(PX_MESSAGES.bracketMin(label, n));
    expect((await call("search_orders", { accountId: 1, startTimestamp: new Date(T0 - 864e5).toISOString() })).data).toEqual([]);
    expect((await journal.read({ kind: "order_blocked" }))[0].text).toMatch(/minimum bracket distance is 4/);
  });

  it.each([
    ["buy", 10, 20, 20000.25, 19997.75, 20005.25],
    ["buy", -10, -20, 20000.25, 19997.75, 20005.25],
    ["sell", 10, 20, 19999.75, 20002.25, 19994.75],
    ["sell", -10, 20, 19999.75, 20002.25, 19994.75],
  ])("puts the stop on the loss side and the target on the profit side, whatever the sign (%s, stop %i, target %i)", async (side, sl, tp, fill, stopAt, targetAt) => {
    const { call } = await setup();
    const res = await call("place_order", { ...order, side, stopLossBracket: { ticks: sl, type: "stop" }, takeProfitBracket: { ticks: tp, type: "limit" } });
    expect(res.data.protection).toMatchObject({ status: "protected", fillPrice: fill });
    const legs = (await call("list_open_orders", { accountId: 1 })).data;
    expect(legs.map((o: any) => [o.typeName, o.stopPrice ?? o.limitPrice])).toEqual([["stop", stopAt], ["limit", targetAt]]);
  });

  // projectx-mcp's enums.ts bracketOf: `bracket: { role: "stop" }` only on a stop (type 4) order tagged
  // "-SL" (its stop bracket leg); target legs, trailing-stop legs and every other order carry none, and no
  // `entry` is set.
  it("marks the stop leg with bracket { role: stop }, as projectx-mcp does, and nothing else", async () => {
    const { call } = await setup();
    await call("place_order", bracketed);
    await call("place_order", { ...order, type: "limit", limitPrice: 19000 });
    const open = (await call("list_open_orders", { accountId: 1 })).data;
    expect(open.map((o: any) => [o.typeName, o.bracket])).toEqual([["stop", { role: "stop" }], ["limit", undefined], ["limit", undefined]]);
    const all = (await call("search_orders", { accountId: 1, startTimestamp: new Date(0).toISOString() })).data;
    expect(all.filter((o: any) => o.bracket).map((o: any) => o.bracket)).toEqual([{ role: "stop" }]);
    const snap = (await call("get_account_snapshot", { accountId: 1 })).data;
    expect(snap.openOrders.filter((o: any) => o.bracket)).toHaveLength(1);
  });

  it("a trailing-stop stop leg carries no bracket, as projectx-mcp marks only type-4 legs", async () => {
    const { call } = await setup();
    await call("place_order", { ...order, stopLossBracket: { ticks: 10, type: "trailing_stop" } });
    const open = (await call("list_open_orders", { accountId: 1 })).data;
    expect(open.length).toBeGreaterThan(0);
    expect(open.some((o: any) => "bracket" in o)).toBe(false);
  });

  it("a 4-tick bracket is taken", async () => {
    const { call } = await setup();
    expect((await call("place_order", { ...order, stopLossBracket: { ticks: 4, type: "stop" } })).data.protection.status).toBe("protected");
  });
});

describe("2. protection result", () => {
  it("protected: a bracketed market entry that fills, with its stop leg", async () => {
    const { call } = await setup();
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(false);
    expectShape(res.data, PX_PLACE_FIELDS);
    expectShape(res.data.protection, PX_PROTECTION_FIELDS);
    expect(res.data).toMatchObject({ success: true, errorCode: 0, errorName: "Success", errorMessage: null, customTag: expect.stringMatching(/^bt-/) });
    expect(res.data.protection).toEqual({ status: "protected", stopOrderId: 2, filledSize: 1, fillPrice: 20000.25, targetPlaced: true, message: PX_MESSAGES.protected });
  });

  it("pending_fill: a resting entry with a stop-loss bracket", async () => {
    const { call } = await setup();
    const res = await call("place_order", { ...bracketed, type: "limit", limitPrice: 19990 });
    expect(res.isError).toBe(false);
    expect(res.data.protection).toEqual({ status: "pending_fill", stopOrderId: null, filledSize: null, fillPrice: null, targetPlaced: true, message: PX_MESSAGES.pendingFill });
  });

  it("not_filled: a market entry that can't fill now (no trade this minute) is cancelled, errorCode 2 OrderRejected", async () => {
    const { call, journal } = await setup({ data: gap(), now: T0 + 30_000 });
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(true);
    expectShape(res.data, PX_PLACE_FIELDS);
    expectShape(res.data.protection, PX_PROTECTION_FIELDS);
    expect(res.data).toMatchObject({ orderId: 1, success: false, errorCode: 2, errorName: "OrderRejected", errorMessage: PX_MESSAGES.notFilledInTime, protection: { status: "not_filled", targetPlaced: false } });
    expect((await call("list_open_orders", { accountId: 1 })).data).toEqual([]);
    expect((await call("list_open_positions", { accountId: 1 })).data).toEqual([]);
    expect((await journal.read({ tag: "protection" })).map((e) => e.text)).toEqual(["fill not confirmed in time: cancel entry 1: ok"]);
  });

  it("not_filled in a next-bar run too: the entry would only fill at the next minute's open", async () => {
    const { call } = await setup({ now: T0 + 30_000, env: { BACKTESTER_MARKET_FILL: "next-bar" } });
    expect((await call("place_order", bracketed)).data).toMatchObject({ success: false, errorCode: 2, protection: { status: "not_filled" } });
  });

  it("flattened_stop_unconfirmed: the stop leg doesn't cover the whole position, so the server flattens", async () => {
    const { call, journal } = await setup();
    await call("place_order", order); // long 1 without a stop
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ success: true, errorCode: 0 });
    expectShape(res.data.protection, PX_PROTECTION_FIELDS);
    expectShape(res.data.protection.flatten, PX_FLATTEN_FIELDS);
    expect(res.data.protection).toMatchObject({ status: "flattened_stop_unconfirmed", filledSize: 1, fillPrice: 20000.25, targetPlaced: false, message: PX_MESSAGES.flattened(MNQ), flatten: { status: "flat" } });
    expect((await call("list_open_positions", { accountId: 1 })).data).toEqual([]);
    expect((await call("list_open_orders", { accountId: 1 })).data).toEqual([]);
    expect((await journal.read({ tag: "protection" })).at(-1)!.text).toBe("flatten after unconfirmed stop: filled but its stop leg was not confirmed in time -> flat");
  });

  it("a limit-type stop-loss leg is not a stop: flattened", async () => {
    const { call } = await setup();
    expect((await call("place_order", { ...order, stopLossBracket: { ticks: 10, type: "limit" } })).data.protection.status).toBe("flattened_stop_unconfirmed");
  });

  it("a sell that only reduces a long runs no protection", async () => {
    const { call } = await setup();
    await call("place_order", order);
    const res = await call("place_order", { ...bracketed, side: "sell" });
    expect(res.data.protection).toBeUndefined();
    expect(res.data.success).toBe(true);
  });

  it("a bracketed reversal is opening: protection covers the new short", async () => {
    const { call } = await setup({ env: { BACKTESTER_MAX_ORDER_SIZE: "2" } });
    await call("place_order", order);
    const res = await call("place_order", { ...bracketed, side: "sell", size: 2 });
    expect(res.data.protection).toMatchObject({ status: "protected", filledSize: 2 });
    expect((await call("list_open_positions", { accountId: 1 })).data).toMatchObject([{ direction: "short", size: 1 }]);
  });

  it("every status is one of projectx-mcp's", async () => {
    const { call } = await setup();
    expect(PX_STATUSES).toContain((await call("place_order", bracketed)).data.protection.status);
  });
});

describe("3. close_position", () => {
  it("flat: closes, cancels every working order on the contract, verifies", async () => {
    const { call, journal } = await setup();
    await call("place_order", bracketed);
    await call("place_order", { ...order, side: "sell", type: "stop", stopPrice: 19990 }); // a stop the client placed itself
    const res = await call("close_position", { accountId: 1, contractId: MNQ, reason: "target hit" });
    expect(res.isError).toBe(false);
    expectShape(res.data, PX_CLOSE_FIELDS);
    expectShape(res.data.close, PX_CLOSE_OUTCOME_FIELDS);
    expect(res.data).toEqual({
      status: "flat", success: true, close: { success: true, errorCode: 0, errorName: "Success", errorMessage: null },
      positionNet: 0, positionSize: 0, cancelledOrderIds: [4], remainingOrderIds: [],
    });
    expect((await call("list_open_orders", { accountId: 1 })).data).toEqual([]);
    expect((await journal.read({ kind: "exit" }))[0]).toMatchObject({ text: "target hit", data: { status: "flat" } });
  });

  it("flat even when already flat: the close fails (PositionNotFound) and the leftover orders are cancelled", async () => {
    const { call } = await setup();
    await call("place_order", { ...order, type: "limit", limitPrice: 19990 });
    const res = await call("close_position", { accountId: 1, contractId: MNQ });
    expect(res.data).toMatchObject({ status: "flat", success: true, close: { success: false, errorCode: 2, errorName: "PositionNotFound" }, cancelledOrderIds: [1] });
  });

  it("still_open: the close waits for the next bar; the orders stay so the position keeps its stop", async () => {
    const { call, setNow } = await setup({ data: gap(), now: T0 - MIN });
    await call("place_order", bracketed);
    setNow(T0 + 30_000);
    const res = await call("close_position", { accountId: 1, contractId: MNQ });
    expect(res.isError).toBe(true);
    expectShape(res.data, PX_CLOSE_FIELDS);
    expect(res.data).toMatchObject({ status: "still_open", success: false, close: { success: true }, positionNet: 1, positionSize: 1, cancelledOrderIds: [], remainingOrderIds: null });
    expect((await call("list_open_orders", { accountId: 1 })).data.map((o: any) => o.typeName)).toEqual(["stop", "limit", "market"]);
    setNow(T0 + 2 * MIN);
    expect((await call("list_open_positions", { accountId: 1 })).data).toEqual([]);
    expect((await call("close_position", { accountId: 1, contractId: MNQ })).data).toMatchObject({ status: "flat", success: true });
  });

  it("every status is one of projectx-mcp's", async () => {
    const { call } = await setup();
    expect(PX_FLAT_STATUSES).toContain((await call("close_position", { accountId: 1, contractId: MNQ })).data.status);
  });

  it("a guardrail refusal is a plain error, as in projectx-mcp", async () => {
    const { call } = await setup({ env: { BACKTESTER_TRADING_ENABLED: "false" } });
    const res = await call("close_position", { accountId: 1, contractId: MNQ });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Blocked by risk guardrail: Trading is disabled/);
  });
});

describe("4. canTrade refusal", () => {
  /** A $1 account: long 2, then selling 1 at a 2-tick loss takes the balance below zero (canTrade=false), long 1 left. */
  async function locked() {
    const s = await setup({ env: { BACKTESTER_START_BALANCE: "1", BACKTESTER_MAX_ORDER_SIZE: "2", BACKTESTER_ACCOUNT_NAME: "ACC1" } });
    await s.call("place_order", { ...order, size: 2 });
    await s.call("place_order", { ...order, side: "sell" });
    expect((await s.call("list_accounts")).data[0]).toMatchObject({ canTrade: false });
    return s;
  }

  it("refuses an opening order as AccountViolation and journals it", async () => {
    const { call, journal } = await locked();
    const res = await call("place_order", order);
    expect(res.isError).toBe(true);
    expect(res.data).toEqual({ orderId: null, success: false, errorCode: 4, errorName: "AccountViolation", errorMessage: PX_MESSAGES.canTrade("ACC1") });
    expect((await journal.read({ kind: "order_blocked" })).at(-1)!.text).toBe(`${PX_MESSAGES.canTrade("ACC1")} | rationale: ${RATIONALE}`);
  });

  it("a reversal counts as opening: refused", async () => {
    const { call } = await locked();
    expect((await call("place_order", { ...order, side: "sell", size: 2 })).data).toMatchObject({ success: false, errorCode: 4 });
  });

  it("an order that only reduces the position still goes through", async () => {
    const { call } = await locked();
    const res = await call("place_order", { ...order, side: "sell" });
    expect(res.isError).toBe(false);
    expect((await call("list_open_positions", { accountId: 1 })).data).toEqual([]);
  });
});

describe("5. tick rounding", () => {
  const at21000 = () => setup({ data: { NQ: flat(T0 - 60 * MIN, 180, 21000) } });

  it.each([
    ["stop", "sell", "stopPrice", 20999.9, 20999.75],
    ["stop", "buy", "stopPrice", 21000.1, 21000.25],
    ["trailing_stop", "sell", "trailPrice", 20999.9, 20999.75],
    ["trailing_stop", "buy", "trailPrice", 21000.1, 21000.25],
    ["limit", "buy", "limitPrice", 21000.1, 21000],
    ["limit", "sell", "limitPrice", 21000.1, 21000.25],
  ])("place_order rounds a %s %s %s away from the market", async (type, side, field, from, to) => {
    const { call, journal } = await at21000();
    const res = await call("place_order", { ...order, type, side, [field]: from });
    expect(res.isError).toBe(false);
    expect(res.data.snapped).toEqual({ [field]: { from, to } });
    const [entry] = await journal.read({ kind: "order_placed" });
    expect((entry.data as any).result.snapped).toEqual({ [field]: { from, to } });
    const [placed] = (await call("search_orders", { accountId: 1, startTimestamp: new Date(T0 - 864e5).toISOString() })).data;
    expect(field === "limitPrice" ? placed.limitPrice : placed.trailPrice !== null ? Math.round((21000 + (side === "buy" ? 1 : -1) * placed.trailPrice) * 100) / 100 : placed.stopPrice).toBe(to);
  });

  it("place_order fixes float noise and leaves on-grid prices untouched", async () => {
    const { call } = await at21000();
    const noisy = await call("place_order", { ...order, type: "limit", side: "sell", limitPrice: 21000.249999 });
    expect(noisy.data.snapped).toEqual({ limitPrice: { from: 21000.249999, to: 21000.25 } });
    const clean = await call("place_order", { ...order, type: "limit", side: "sell", limitPrice: 21000.75, size: 1, rationale: RATIONALE });
    expect(clean.data.snapped).toBeUndefined();
  });

  it.each([
    ["sell", "stop", "stopPrice", 20999, 20999.9, 20999.75],
    ["buy", "stop", "stopPrice", 21001, 21000.1, 21000.25],
    ["buy", "limit", "limitPrice", 20990, 21000.1, 21000],
    ["sell", "limit", "limitPrice", 21010, 21000.1, 21000.25],
  ])("modify_order rounds by the working order's side (%s %s %s)", async (side, type, field, first, from, to) => {
    const { call, journal } = await at21000();
    await call("place_order", { ...order, side, type, [field]: first });
    const res = await call("modify_order", { accountId: 1, orderId: 1, [field]: from });
    expect(res.data).toMatchObject({ success: true, snapped: { [field]: { from, to } } });
    const [note] = await journal.read({ tag: "tick-snap" });
    expect(note).toMatchObject({ kind: "note", orderId: 1, text: `modify order 1: price change (snapped to tick: ${JSON.stringify({ [field]: { from, to } })})`, data: { snapped: { [field]: { from, to } } } });
    expect((await call("list_open_orders", { accountId: 1 })).data[0][field]).toBe(to);
  });

  it("modify_order passes trailPrice through unchanged (the replay broker then refuses it off the grid)", async () => {
    const { call } = await at21000();
    await call("place_order", { ...order, side: "sell", type: "trailing_stop", trailPrice: 20999 });
    const res = await call("modify_order", { accountId: 1, orderId: 1, trailPrice: 20999.9 });
    expect(res.data.snapped).toBeUndefined();
    expect(res.data).toMatchObject({ success: false, errorCode: 3, errorName: "Rejected", errorMessage: expect.stringMatching(/trailPrice 20999.9 is not a multiple/) });
  });

  it("modify_order changes nothing when the working order can't be read", async () => {
    const { call } = await at21000();
    const res = await call("modify_order", { accountId: 1, orderId: 7, stopPrice: 20999.9 });
    expect(res.data).toMatchObject({ success: false, errorName: "OrderNotFound" });
    expect(res.data.snapped).toBeUndefined();
  });
});

describe("6. the answer budget", () => {
  it("every order tool answers well within projectx-mcp's 9.5 s budget", async () => {
    const { call } = await setup();
    const t = Date.now();
    await call("place_order", bracketed);
    await call("modify_order", { accountId: 1, orderId: 2, stopPrice: 19998 });
    await call("cancel_order", { accountId: 1, orderId: 3 });
    await call("partial_close_position", { accountId: 1, contractId: MNQ, size: 1 });
    await call("close_position", { accountId: 1, contractId: MNQ });
    expect(Date.now() - t).toBeLessThan(9_500);
  });
});

describe("review round 1", () => {
  it("a failing journal never fails an order tool (place, modify, cancel, close, partial close)", async () => {
    const { call, journal } = await setup({ env: { BACKTESTER_MAX_ORDER_SIZE: "2" } });
    journal.add = async () => {
      throw new Error("read-only disk");
    };
    expect((await call("place_order", { ...bracketed, size: 2 })).data).toMatchObject({ success: true, protection: { status: "protected" } });
    expect((await call("modify_order", { accountId: 1, orderId: 2, stopPrice: 19998.1, reason: "tighten" })).data).toMatchObject({ success: true, snapped: { stopPrice: { from: 19998.1, to: 19998 } } });
    expect((await call("cancel_order", { accountId: 1, orderId: 3 })).data.success).toBe(true);
    expect((await call("partial_close_position", { accountId: 1, contractId: MNQ, size: 1, reason: "scale" })).data.success).toBe(true);
    expect((await call("close_position", { accountId: 1, contractId: MNQ, reason: "done" })).data).toMatchObject({ status: "flat", success: true });
    const blocked = await call("place_order", { ...order, stopLossBracket: { ticks: 2, type: "stop" } });
    expect(blocked.text).toMatch(/^Blocked by risk guardrail: /);
    const s2 = await setup({ data: gap(), now: T0 + 30_000 });
    s2.journal.add = async () => {
      throw new Error("read-only disk");
    };
    expect((await s2.call("place_order", bracketed)).data).toMatchObject({ errorCode: 2, protection: { status: "not_filled" } });
  });

  it("generated customTags follow bt-<run>-<order id>, and a refused order uses none up", async () => {
    const { call } = await setup({ env: { BACKTESTER_RUN_ID: "r1", BACKTESTER_MAX_POSITION_SIZE: "5" } });
    const refused = await call("place_order", { ...order, contractId: "BT.ES" }); // no ES data: refused by the broker
    expect(refused.data).toMatchObject({ success: false, errorCode: 9, customTag: null });
    expect((await call("place_order", { ...order, contractId: "BT.ES", customTag: "mine" })).data).toMatchObject({ success: false, customTag: "mine" });
    expect((await call("place_order", { ...order, type: "limit", limitPrice: 19990 })).data.customTag).toBe("bt-r1-1");
    expect((await call("place_order", { ...order, type: "limit", limitPrice: 19990, customTag: "bt-r1-3" })).data.customTag).toBe("bt-r1-3");
    // The next generated tag would be bt-r1-3, which the caller took: it moves on.
    expect((await call("place_order", { ...order, type: "limit", limitPrice: 19990 })).data.customTag).toBe("bt-r1-3-2");
    const tags = (await call("search_orders", { accountId: 1, startTimestamp: new Date(T0 - 864e5).toISOString() })).data.map((o: any) => o.customTag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("a waiting close that fills at the next bar cancels the orders working when it was sent, as live", async () => {
    const { call, setNow } = await setup({ data: gap(), now: T0 - MIN });
    await call("place_order", order); // long 1, no bracket
    await call("place_order", { ...order, side: "sell", type: "stop", stopPrice: 19990, rationale: `[protect] ${RATIONALE}` }); // a repair stop
    setNow(T0 + 30_000);
    expect((await call("close_position", { accountId: 1, contractId: MNQ })).data).toMatchObject({ status: "still_open" });
    setNow(T0 + 2 * MIN);
    expect((await call("list_open_positions", { accountId: 1 })).data).toEqual([]);
    expect((await call("list_open_orders", { accountId: 1 })).data).toEqual([]);
    const stop = (await call("search_orders", { accountId: 1, startTimestamp: new Date(T0 - 864e5).toISOString() })).data.find((o: any) => o.id === 2);
    expect(stop).toMatchObject({ statusName: "cancelled", updateTimestamp: new Date(T0 + MIN).toISOString() });
  });

  it("an order sent after the waiting close is not cancelled when it fills", async () => {
    const { call, setNow } = await setup({ data: gap(), now: T0 - MIN });
    await call("place_order", order);
    setNow(T0 + 30_000);
    await call("close_position", { accountId: 1, contractId: MNQ });
    await call("place_order", { ...order, type: "limit", limitPrice: 19990 }); // sent after the close
    setNow(T0 + 2 * MIN);
    expect((await call("list_open_orders", { accountId: 1 })).data.map((o: any) => o.limitPrice)).toEqual([19990]);
  });

  it("canTrade is false at a balance of exactly 0: opening refused", async () => {
    const { call } = await setup({ env: { BACKTESTER_START_BALANCE: "1", BACKTESTER_FEES_MICRO: "0", BACKTESTER_MAX_ORDER_SIZE: "2" } });
    await call("place_order", { ...order, size: 2 }); // 20000.25
    await call("place_order", { ...order, side: "sell" }); // 19999.75: -2 ticks = -$1.00
    expect((await call("list_accounts")).data[0]).toMatchObject({ balance: 0, canTrade: false });
    expect((await call("place_order", order)).data).toMatchObject({ errorCode: 4, errorName: "AccountViolation" });
  });

  it.each([
    ["stop", "stopPrice", 20999],
    ["limit", "limitPrice", 20990],
  ])("modify_order passes trailPrice through beside a rounded %s price", async (type, field, first) => {
    const { call } = await setup({ data: { NQ: flat(T0 - 60 * MIN, 180, 21000) } });
    await call("place_order", { ...order, side: type === "stop" ? "sell" : "buy", type, [field]: first });
    const res = await call("modify_order", { accountId: 1, orderId: 1, trailPrice: 20999.9, [field]: 20999.9 });
    expect(res.data.snapped).toEqual({ [field]: { from: 20999.9, to: type === "stop" ? 20999.75 : 20999.75 } });
    // The replay broker sees trailPrice exactly as sent (and refuses it off the grid).
    expect(res.data.errorMessage).toBe("trailPrice 20999.9 is not a multiple of the tick size 0.25.");
  });

  it("a size increase fails closed when the working orders can't be read; a size cut is taken", async () => {
    const { call, exchange } = await setup({ env: { BACKTESTER_MAX_ORDER_SIZE: "2" } });
    await call("place_order", { ...order, type: "limit", limitPrice: 19990, size: 2 });
    const real = exchange.openOrders.bind(exchange);
    exchange.openOrders = () => {
      throw new Error("state unreadable");
    };
    const cut = await call("modify_order", { accountId: 1, orderId: 1, size: 1 });
    expect(cut.data).toMatchObject({ success: true });
    const grow = await call("modify_order", { accountId: 1, orderId: 1, size: 2 });
    expect(grow.isError).toBe(true);
    expect(grow.text).toBe("Blocked by risk guardrail: the working orders could not be read, so a size increase (1 to 2) can't be checked against the position and daily loss limits. A size cut is taken.");
    // A price change still goes through, unrounded (as projectx-mcp when the order can't be read).
    expect((await call("modify_order", { accountId: 1, orderId: 1, limitPrice: 19991 })).data.success).toBe(true);
    exchange.openOrders = real;
    expect((await call("list_open_orders", { accountId: 1 })).data[0]).toMatchObject({ size: 1, limitPrice: 19991 });
  });

  it.each([
    ["a market exit", (call: any) => call("place_order", { ...order, side: "sell" })],
    ["a partial close", (call: any) => call("partial_close_position", { accountId: 1, contractId: MNQ, size: 1 })],
  ])("a waiting close still cancels its orders when %s sent before it flattened first", async (_name, exit) => {
    const { call, setNow } = await setup({ data: gap(), now: T0 - MIN });
    await call("place_order", order); // long 1
    await call("place_order", { ...order, side: "sell", type: "stop", stopPrice: 19990, rationale: `[protect] ${RATIONALE}` }); // repair stop, id 2
    setNow(T0 + 30_000);
    await exit(call); // waits for the next bar, ahead of the close
    expect((await call("close_position", { accountId: 1, contractId: MNQ })).data).toMatchObject({ status: "still_open" });
    setNow(T0 + 2 * MIN);
    expect((await call("list_open_positions", { accountId: 1 })).data).toEqual([]);
    expect((await call("list_open_orders", { accountId: 1 })).data).toEqual([]);
    const all = (await call("search_orders", { accountId: 1, startTimestamp: new Date(T0 - 864e5).toISOString() })).data;
    expect(all.find((o: any) => o.id === 2)).toMatchObject({ statusName: "cancelled" });
  });

  it("server: an unconfirmed flatten after an unprotected fill is unknown, an error, its message in errorMessage", async () => {
    const { call, exchange } = await setup();
    await call("place_order", order); // long 1 without a stop: the bracketed add won't be covered
    exchange.flatten = () => ({ status: "still_open", close: { success: false, errorCode: 6, errorMessage: "halted" }, positionNet: 2, positionSize: 2, cancelledOrderIds: [], failedCancelOrderIds: [], remainingOrderIds: null });
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ success: true, protection: { status: "unknown", flatten: { status: "still_open" } } });
    expect(res.data.errorMessage).toBe(res.data.protection.message);
    expect(res.data.errorMessage).toMatch(/^UNPROTECTED POSITION MAY BE OPEN on BT\.MNQ: .*\(still_open\)/);
  });

  it("the replay flatten never ends legs_left: its cancels run in the same transaction as the check", async () => {
    const { call, exchange } = await setup({ env: { BACKTESTER_MAX_POSITION_SIZE: "5" } });
    for (const p of [19990, 19985, 19980]) await call("place_order", { ...order, type: "limit", limitPrice: p });
    const fl = exchange.flatten(1, MNQ);
    expect(fl).toMatchObject({ status: "flat", cancelledOrderIds: [1, 2, 3], failedCancelOrderIds: [], remainingOrderIds: [] });
  });
});
