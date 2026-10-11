import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BarStore } from "../src/bars.js";
import { CONTRACTS, ReplayExchange, frontMonthName, specOf, type PlaceRequest } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { MIN, T0, defaultData, flat, iso, seq, setup, tmp, writeData, type Row } from "./helpers.js";

const req = (p: Partial<PlaceRequest> = {}): PlaceRequest => ({
  accountId: 1, contractId: "BT.MNQ", type: 2, side: 0, size: 1, limitPrice: null, stopPrice: null, trailPrice: null,
  customTag: null, stopLossBracket: null, takeProfitBracket: null, ...p,
});

describe("contracts", () => {
  it("lists contracts whose data file exists, micros on their mini's file, exact root first", async () => {
    const { exchange } = await setup({ data: { NQ: flat(T0 - 10 * MIN, 20, 20000), GC: flat(T0 - 10 * MIN, 20, 2000) } });
    expect(exchange.searchContracts("MNQ")).toEqual([
      { id: "BT.MNQ", name: "MNQH24", description: "Micro E-mini Nasdaq-100 (replay of NQ_1min.csv)", tickSize: 0.25, tickValue: 0.5, activeContract: true, symbolId: "F.US.MNQ" },
    ]);
    expect(exchange.searchContracts("nq").map((c) => c.id)).toEqual(["BT.NQ", "BT.MNQ"]);
    expect(exchange.searchContracts("ES")).toEqual([]);
    expect(exchange.allContracts().map((c) => c.id)).toEqual(["BT.NQ", "BT.MNQ", "BT.GC", "BT.MGC"]);
    expect(exchange.contract("BT.MGC")).toMatchObject({ tickSize: 0.1, tickValue: 1 });
    expect(() => exchange.contract("BT.ES")).toThrow(/not found/);
    expect(() => exchange.contract("CON.F.US.MNQ.H24")).toThrow(/not found/);
    expect(exchange.dataRanges()).toMatchObject({ NQ: { file: "NQ_1min.csv", first: iso(T0 - 10 * MIN) }, MGC: { file: "GC_1min.csv" } });
  });

  it("has the documented tick specs", () => {
    const ticks = Object.fromEntries(Object.values(CONTRACTS).map((c) => [c.root, [c.tickSize, c.tickValue, c.dataRoot]]));
    expect(ticks).toMatchObject({
      MNQ: [0.25, 0.5, "NQ"], NQ: [0.25, 5, "NQ"], MES: [0.25, 1.25, "ES"], ES: [0.25, 12.5, "ES"], MYM: [1, 0.5, "YM"], YM: [1, 5, "YM"],
      M2K: [0.1, 0.5, "RTY"], RTY: [0.1, 5, "RTY"], MGC: [0.1, 1, "GC"], GC: [0.1, 10, "GC"], SIL: [0.005, 5, "SI"], SI: [0.005, 25, "SI"],
    });
    expect(specOf("BT.XX")).toBeNull();
  });

  it("names the front month by each market's cycle", () => {
    expect(frontMonthName(CONTRACTS.MNQ, new Date("2024-03-05T15:00:00Z"))).toBe("MNQH24");
    expect(frontMonthName(CONTRACTS.MNQ, new Date("2024-03-08T15:00:00Z"))).toBe("MNQM24"); // rolled 8 days before the 15 Mar expiry
    expect(frontMonthName(CONTRACTS.ES, new Date("2024-12-20T15:00:00Z"))).toBe("ESH25");
    expect(frontMonthName(CONTRACTS.GC, new Date("2024-10-15T15:00:00Z"))).toBe("GCZ24");
    expect(frontMonthName(CONTRACTS.SI, new Date("2024-03-05T15:00:00Z"))).toBe("SIK24");
    expect(frontMonthName(CONTRACTS.CL, new Date("2024-03-05T15:00:00Z"))).toBe("CLJ24");
  });
});

describe("market orders", () => {
  it("fill at once when the clock sits on a bar's open, at that open plus a tick", async () => {
    const { exchange } = await setup({ data: { NQ: seq(T0 - MIN, [[19999, 19999, 19999, 19999], [20001, 20002, 20000, 20001]]) } });
    expect(exchange.place(req())).toMatchObject({ success: true, orderId: 1 });
    expect(exchange.positions(1)).toEqual([{ id: 1, accountId: 1, contractId: "BT.MNQ", creationTimestamp: iso(T0), type: 1, size: 1, averagePrice: 20001.25 }]);
    expect(exchange.trades(1, iso(T0 - 864e5))).toMatchObject([{ id: 1, price: 20001.25, profitAndLoss: null, fees: 0.37, side: 0, orderId: 1 }]);
    expect(exchange.openOrders(1)).toEqual([]);
  });

  it("placed inside a bar, wait for the next bar's open", async () => {
    const { exchange, setNow } = await setup({ now: T0 + 30000, data: { NQ: seq(T0, [[20000, 20003, 19999, 20002], [20004, 20005, 20003, 20004]]) } });
    exchange.place(req({ side: 1 }));
    expect(exchange.positions(1)).toEqual([]);
    expect(exchange.openOrders(1)).toMatchObject([{ id: 1, status: 1, type: 2 }]);
    setNow(T0 + MIN);
    expect(exchange.positions(1)).toMatchObject([{ type: 2, size: 1, averagePrice: 20003.75 }]);
  });

  it("are refused when the market is closed, outside the data, or past the window", async () => {
    // Data stops at 21:59Z (16:59 ET); the next session opens 23:00Z.
    const data = { NQ: [...flat(Date.parse("2024-03-05T21:50:00Z"), 10, 20000), ...flat(Date.parse("2024-03-05T23:00:00Z"), 5, 20010)] };
    const closed = await setup({ now: Date.parse("2024-03-05T22:30:00Z"), data });
    expect(closed.exchange.place(req())).toMatchObject({ success: false, errorCode: 5, orderId: null, errorMessage: expect.stringMatching(/market is closed/) });
    const after = await setup({ now: Date.parse("2024-03-06T00:00:00Z"), data });
    expect(after.exchange.place(req())).toMatchObject({ errorCode: 5, errorMessage: expect.stringMatching(/no data after/) });
    // A position held into the daily break can't be closed until the market opens (OrderRejected).
    const held = await setup({ now: Date.parse("2024-03-05T21:58:00Z"), data });
    held.exchange.place(req());
    held.setNow(Date.parse("2024-03-05T22:30:00Z"));
    expect(held.exchange.close(1, "BT.MNQ", null)).toMatchObject({ success: false, errorCode: 6, errorMessage: expect.stringMatching(/market is closed/) });
    expect(held.exchange.openOrders(1)).toEqual([]);
    const ended = await setup({ now: Date.parse("2024-03-05T21:54:30Z"), data, env: { BACKTESTER_END: "2024-03-05T21:54:30Z" } });
    expect(ended.exchange.place(req())).toMatchObject({ errorCode: 5, errorMessage: expect.stringMatching(/BACKTESTER_END/) });
  });
});

describe("order validation", () => {
  it("refuses with the interface's place codes", async () => {
    const { exchange } = await setup();
    expect(exchange.place(req({ accountId: 2 }))).toMatchObject({ errorCode: 1, orderId: null });
    expect(exchange.place(req({ contractId: "BT.ZZ" }))).toMatchObject({ errorCode: 8 });
    expect(exchange.place(req({ contractId: "BT.ES" }))).toMatchObject({ errorCode: 9 });
    expect(exchange.place(req({ type: 1, limitPrice: 19990.1 }))).toMatchObject({ errorCode: 2, errorMessage: expect.stringMatching(/tick size/) });
    expect(exchange.place(req({ stopLossBracket: { ticks: 0, type: 4 } }))).toMatchObject({ errorCode: 2 });
    expect(exchange.place(req({ stopLossBracket: { ticks: 4, type: 2 } }))).toMatchObject({ errorCode: 2 });
    expect(exchange.place(req({ type: 1, limitPrice: 19990, customTag: "a" }))).toMatchObject({ success: true });
    expect(exchange.place(req({ type: 1, limitPrice: 19990, customTag: "a" }))).toMatchObject({ errorCode: 2, errorMessage: expect.stringMatching(/customTag/) });
  });

  it("joins the last price and places trailing stops from it", async () => {
    const { exchange } = await setup();
    expect(exchange.place(req({ type: 6 }))).toMatchObject({ success: true });
    expect(exchange.openOrders(1)[0]).toMatchObject({ type: 6, limitPrice: 20000 });
    expect(exchange.place(req({ type: 5, side: 1, trailPrice: 20001 }))).toMatchObject({ errorCode: 2, errorMessage: expect.stringMatching(/below/) });
    expect(exchange.place(req({ type: 5, side: 1, trailPrice: 19995 }))).toMatchObject({ success: true });
    expect(exchange.searchOrders(1, iso(T0 - MIN))[1]).toMatchObject({ type: 5, stopPrice: 19995, trailPrice: 5 });
  });
});

describe("order management", () => {
  it("modifies, cancels, and refuses with the edit codes", async () => {
    const { exchange } = await setup();
    exchange.place(req({ type: 4, side: 1, stopPrice: 19990 }));
    expect(exchange.modify({ accountId: 1, orderId: 1, size: 2, limitPrice: null, stopPrice: 19992.5, trailPrice: null })).toEqual({ success: true, errorCode: 0, errorMessage: null });
    expect(exchange.openOrders(1)[0]).toMatchObject({ size: 2, stopPrice: 19992.5 });
    expect(exchange.modify({ accountId: 1, orderId: 1, size: null, limitPrice: 19990, stopPrice: null, trailPrice: null })).toMatchObject({ errorCode: 3 });
    expect(exchange.modify({ accountId: 1, orderId: 1, size: null, limitPrice: null, stopPrice: 1.1, trailPrice: null })).toMatchObject({ errorCode: 3 });
    expect(exchange.modify({ accountId: 1, orderId: 1, size: null, limitPrice: null, stopPrice: null, trailPrice: 19990 })).toMatchObject({ errorCode: 3 });
    expect(exchange.modify({ accountId: 1, orderId: 9, size: null, limitPrice: null, stopPrice: 1, trailPrice: null })).toMatchObject({ errorCode: 2 });
    expect(exchange.modify({ accountId: 3, orderId: 1, size: null, limitPrice: null, stopPrice: 1, trailPrice: null })).toMatchObject({ errorCode: 1 });
    expect(exchange.cancel(1, 1)).toMatchObject({ success: true });
    expect(exchange.cancel(1, 1)).toMatchObject({ errorCode: 2 });
    expect(exchange.cancel(2, 1)).toMatchObject({ errorCode: 1 });
    expect(exchange.searchOrders(1, iso(T0))[0]).toMatchObject({ status: 3 });
  });

  it("modifies a trailing stop's level and a limit's price; refuses a waiting market order", async () => {
    const { exchange } = await setup({ now: T0 + 30000 });
    exchange.place(req({ type: 5, side: 1, trailPrice: 19995 }));
    exchange.place(req({ type: 1, limitPrice: 19990 }));
    exchange.place(req());
    expect(exchange.modify({ accountId: 1, orderId: 1, size: null, limitPrice: null, stopPrice: null, trailPrice: 19998 })).toMatchObject({ success: true });
    expect(exchange.modify({ accountId: 1, orderId: 2, size: null, limitPrice: 19991, stopPrice: null, trailPrice: null })).toMatchObject({ success: true });
    expect(exchange.modify({ accountId: 1, orderId: 3, size: 1, limitPrice: null, stopPrice: null, trailPrice: null })).toMatchObject({ errorCode: 3 });
    expect(exchange.openOrders(1).slice(0, 2)).toMatchObject([{ stopPrice: 19998, trailPrice: 2 }, { limitPrice: 19991 }]);
  });

  it("closes and partially closes at market with the close codes", async () => {
    const { exchange, setNow } = await setup();
    expect(exchange.close(1, "BT.MNQ", null)).toMatchObject({ errorCode: 2 });
    expect(exchange.close(1, "BT.ZZ", null)).toMatchObject({ errorCode: 3 });
    expect(exchange.close(1, "BT.ES", null)).toMatchObject({ errorCode: 4 });
    expect(exchange.close(5, "BT.MNQ", null)).toMatchObject({ errorCode: 1 });
    exchange.place(req({ size: 2 }));
    expect(exchange.close(1, "BT.MNQ", 3)).toMatchObject({ errorCode: 5 });
    setNow(T0 + 90000);
    expect(exchange.close(1, "BT.MNQ", 1)).toMatchObject({ success: true });
    expect(exchange.close(1, "BT.MNQ", 2)).toMatchObject({ errorCode: 7 }); // one is already waiting for the next bar
    setNow(T0 + 2 * MIN);
    expect(exchange.positions(1)).toMatchObject([{ size: 1 }]);
    expect(exchange.close(1, "BT.MNQ", null)).toMatchObject({ success: true });
    expect(exchange.positions(1)).toEqual([]);
    const fills = exchange.trades(1, iso(T0));
    expect(fills.map((t) => [t.side, t.size, t.price, t.profitAndLoss])).toEqual([[0, 2, 20000.25, null], [1, 1, 19999.75, -1], [1, 1, 19999.75, -1]]);
    expect(exchange.accounts()[0]).toMatchObject({ balance: 100000 - 2 - 4 * 0.37, canTrade: true });
  });
});

describe("inside a bar", () => {
  // Bar T0+1 trades down to 19990.
  const data = () => ({ NQ: [...flat(T0 - 5 * MIN, 6, 20000), [T0 + MIN, 20000, 20000, 19990, 19992] as Row, ...flat(T0 + 2 * MIN, 5, 19992)] });

  it("a close placed inside a bar never opens a position when the stop fills first", async () => {
    const { exchange, setNow } = await setup({ data: data() });
    exchange.place(req({ stopLossBracket: { ticks: 20, type: 4 } }));
    setNow(T0 + 90000);
    expect(exchange.close(1, "BT.MNQ", null)).toMatchObject({ success: true });
    setNow(T0 + 3 * MIN);
    expect(exchange.positions(1)).toEqual([]);
    expect(exchange.trades(1, iso(T0)).map((t) => [t.side, t.price])).toEqual([[0, 20000.25], [1, 19995]]);
    expect(exchange.searchOrders(1, iso(T0)).at(-1)).toMatchObject({ type: 2, status: 3 });
  });

  it("a modify takes effect at once, on the bar in progress too", async () => {
    const { exchange, setNow } = await setup({ data: data() });
    exchange.place(req({ stopLossBracket: { ticks: 20, type: 4 } })); // stop 19995.25
    setNow(T0 + 90000);
    expect(exchange.modify({ accountId: 1, orderId: 2, size: null, limitPrice: null, stopPrice: 19980, trailPrice: null })).toMatchObject({ success: true });
    setNow(T0 + 2 * MIN); // bar T0+1 dips to 19990: above the moved stop
    expect(exchange.positions(1)).toMatchObject([{ size: 1 }]);
  });

  it("an order shrunk inside a bar fills at its new size, never its old one", async () => {
    const { exchange, setNow } = await setup({ data: data() });
    exchange.place(req({ type: 1, limitPrice: 19995, size: 2 }));
    setNow(T0 + 90000);
    exchange.modify({ accountId: 1, orderId: 1, size: 1, limitPrice: null, stopPrice: null, trailPrice: null });
    setNow(T0 + 2 * MIN);
    expect(exchange.positions(1)).toMatchObject([{ size: 1 }]);
  });

  it("a cancel takes effect at once, inside a bar too", async () => {
    const { exchange, setNow } = await setup({ data: data() });
    exchange.place(req());
    exchange.place(req({ type: 4, side: 1, stopPrice: 19995 }));
    setNow(T0 + 90000);
    expect(exchange.cancel(1, 2)).toMatchObject({ success: true });
    setNow(T0 + 2 * MIN);
    expect(exchange.positions(1)).toMatchObject([{ size: 1 }]);
    expect(exchange.searchOrders(1, iso(T0))[1]).toMatchObject({ id: 2, status: 3 });
  });

  it("creates a mid-bar market order's bracket in one sync and fills it in a later one", async () => {
    const { exchange, setNow } = await setup({ now: T0 + 30000, data: data() });
    exchange.place(req({ stopLossBracket: { ticks: 8, type: 4 } }));
    setNow(T0 + MIN + 10000); // opens at T0+1: long at 20000.25, stop 19998.25
    expect(exchange.openOrders(1)).toMatchObject([{ id: 2, type: 4, stopPrice: 19998.25 }]);
    setNow(T0 + 2 * MIN);
    expect(exchange.positions(1)).toEqual([]);
    expect(exchange.trades(1, iso(T0)).map((t) => [t.orderId, t.price])).toEqual([[1, 20000.25], [2, 19998]]);
  });
});

describe("after BACKTESTER_END", () => {
  it("takes only market orders that reduce the position, at the last close", async () => {
    const { exchange, setNow } = await setup({ env: { BACKTESTER_END: iso(T0 + 10 * MIN) } });
    exchange.place(req({ size: 2 }));
    setNow(T0 + 20 * MIN);
    expect(exchange.place(req({ side: 0 }))).toMatchObject({ errorCode: 5, errorMessage: expect.stringMatching(/replay is over/) });
    expect(exchange.place(req({ side: 1, size: 3 }))).toMatchObject({ errorCode: 5 });
    expect(exchange.place(req({ side: 1, type: 4, stopPrice: 19990 }))).toMatchObject({ errorCode: 5 });
    expect(exchange.place(req({ side: 1 }))).toMatchObject({ success: true });
    expect(exchange.close(1, "BT.MNQ", null)).toMatchObject({ success: true });
    expect(exchange.trades(1, iso(T0)).slice(1).map((t) => [t.side, t.price, t.creationTimestamp])).toEqual([[1, 20000, iso(T0 + 10 * MIN)], [1, 20000, iso(T0 + 10 * MIN)]]);
  });
});

describe("round trips through the exchange", () => {
  it("a stop out and a re-entry at the same moment: the old stop is not the new trade's initial stop; a moved stop reads trail", async () => {
    // Bar T0+1 trades down to 19985 (the 19990 stop fills, stamped T0+2); the re-entry at T0+2's open fills at 20005.25.
    const data = { NQ: [...flat(T0 - 5 * MIN, 5, 20000), ...seq(T0, [[20000, 20001, 19999, 20000], [20000, 20000, 19985, 19990], [20005, 20006, 20004, 20005], [20005, 20005, 19990, 19995], [19995, 19995, 19995, 19995]])] };
    const { exchange, setNow } = await setup({ data });
    exchange.place(req());
    exchange.place(req({ side: 1, type: 4, stopPrice: 19990 }));
    setNow(T0 + 2 * MIN);
    exchange.place(req());
    exchange.place(req({ side: 1, type: 4, stopPrice: 19995 }));
    exchange.modify({ accountId: 1, orderId: 4, size: null, limitPrice: null, stopPrice: 20000, trailPrice: null });
    setNow(T0 + 5 * MIN);
    const [first, second] = exchange.tradeReport(1, iso(T0)).roundTrips;
    expect(first).toMatchObject({ initialStop: 19990, reason: "stop" });
    // Initial stop 19995 (placed at the entry, moved to 20000 later): risk 10.25 points = 41 ticks = $20.50.
    expect(second).toMatchObject({ entryPrice: 20005.25, initialStop: 19995, risk: 10.25, riskDollars: 20.5, reason: "trail", exitPrice: 19999.75 });
  });

  it("orders events of one instant by fill sequence: a stop filling on its entry's bar, a modify or cancel just before an entry", async () => {
    // A buy stop entry at 20002 and its protective sell stop at 19995, both placed inside bar T0; bar T0+1 fills both (stamped T0+2).
    const one = await setup({ now: T0 + 30000, data: { NQ: [...flat(T0 - 5 * MIN, 5, 20000), ...seq(T0, [[20000, 20000, 20000, 20000], [20000, 20004, 19994, 19996], [19996, 19996, 19996, 19996]])] } });
    one.exchange.place(req({ type: 4, stopPrice: 20002 }));
    one.exchange.place(req({ side: 1, type: 4, stopPrice: 19995 }));
    one.setNow(T0 + 3 * MIN);
    // Entry 20002.25, stop 19995: 29 ticks = $14.50; exit 19994.75: -30 ticks = -$15.
    expect(one.exchange.tradeReport(1, iso(T0)).roundTrips[0]).toMatchObject({ entryPrice: 20002.25, initialStop: 19995, riskDollars: 14.5, reason: "stop", r: -1.034 });

    // A stop placed earlier at 19980, moved to 19995 at T0, then a market buy at T0 (fills at once at 20000.25).
    const data = { NQ: [...flat(T0 - 5 * MIN, 5, 20000), ...seq(T0, [[20000, 20001, 19999, 20000], [20000, 20000, 19985, 19990], [19990, 19990, 19990, 19990]])] };
    const two = await setup({ now: T0 - 90000, data });
    two.exchange.place(req({ side: 1, type: 4, stopPrice: 19980 }));
    two.setNow(T0);
    two.exchange.modify({ accountId: 1, orderId: 1, size: null, limitPrice: null, stopPrice: 19995, trailPrice: null });
    two.exchange.place(req());
    two.setNow(T0 + 3 * MIN);
    expect(two.exchange.tradeReport(1, iso(T0)).roundTrips[0]).toMatchObject({ initialStop: 19995, risk: 5.25, reason: "stop" }); // moved before the entry: not a trail

    // A closer stop cancelled at T0 just before a market buy at T0: not the trade's stop.
    const three = await setup({ now: T0 - 90000, data });
    three.exchange.place(req({ side: 1, type: 4, stopPrice: 19998 }));
    three.setNow(T0);
    three.exchange.cancel(1, 1);
    three.exchange.place(req());
    three.exchange.place(req({ side: 1, type: 4, stopPrice: 19990 }));
    three.setNow(T0 + 3 * MIN);
    expect(three.exchange.tradeReport(1, iso(T0)).roundTrips[0]).toMatchObject({ initialStop: 19990, reason: "stop" });

    // The same stop cancelled just after the market buy at T0: it was working at the entry, so it is the initial stop.
    const four = await setup({ now: T0 - 90000, data });
    four.exchange.place(req({ side: 1, type: 4, stopPrice: 19998 }));
    four.setNow(T0);
    four.exchange.place(req());
    four.exchange.cancel(1, 1);
    four.exchange.place(req({ side: 1, type: 4, stopPrice: 19990 }));
    four.setNow(T0 + 3 * MIN);
    expect(four.exchange.tradeReport(1, iso(T0)).roundTrips[0]).toMatchObject({ initialStop: 19998, riskDollars: 4.5 });
  });

  it("a second stop placed later for another contract is not a trail while the first stop still works", async () => {
    // Long 2 at 20000.25; a stop for 1 at 19995 at once, one for the other at 19990 two minutes later; bar T0+3 takes both.
    const data = { NQ: [...flat(T0 - 5 * MIN, 5, 20000), ...seq(T0, [[20000, 20001, 19999, 20000], [20000, 20001, 19999, 20000], [20000, 20001, 19999, 20000], [20000, 20000, 19985, 19986], [19986, 19986, 19986, 19986]])] };
    const { exchange, setNow } = await setup({ data, env: { BACKTESTER_MAX_ORDER_SIZE: "2" } });
    exchange.place(req({ size: 2 }));
    exchange.place(req({ side: 1, type: 4, stopPrice: 19995 }));
    setNow(T0 + 2 * MIN);
    exchange.place(req({ side: 1, type: 4, stopPrice: 19990 }));
    setNow(T0 + 5 * MIN);
    expect(exchange.tradeReport(1, iso(T0)).roundTrips[0]).toMatchObject({ initialStop: 19995, partialExits: 1, reason: "stop", exitPrice: 19992.25 });
  });

  it("a stop cancelled and replaced after the first minute reads trail", async () => {
    const data = { NQ: [...flat(T0 - 5 * MIN, 5, 20000), ...seq(T0, [[20000, 20003, 19999, 20002], [20002, 20004, 20001, 20003], [20003, 20003, 20000, 20001], [20001, 20001, 20001, 20001]])] };
    const { exchange, setNow } = await setup({ data });
    exchange.place(req());
    exchange.place(req({ side: 1, type: 4, stopPrice: 19990 }));
    setNow(T0 + 2 * MIN);
    exchange.cancel(1, 2);
    exchange.place(req({ side: 1, type: 4, stopPrice: 20001 }));
    setNow(T0 + 4 * MIN);
    expect(exchange.tradeReport(1, iso(T0)).roundTrips[0]).toMatchObject({ initialStop: 19990, reason: "trail", exitPrice: 20000.75 });
  });

  it("a close after BACKTESTER_END ends the round trip with reason end", async () => {
    const { exchange, setNow } = await setup({ env: { BACKTESTER_END: iso(T0 + 10 * MIN) } });
    exchange.place(req({ stopLossBracket: { ticks: 20, type: 4 } }));
    setNow(T0 + 20 * MIN);
    expect(exchange.close(1, "BT.MNQ", null)).toMatchObject({ success: true });
    const report = exchange.tradeReport(1, iso(T0));
    // Flat at 20000: the market buy filled at 20000.25, the end fill at the last close 20000 (-1 tick). Bars T0..T0+9 held whole.
    expect(report.trades.at(-1)?.roundTrip).toMatchObject({ reason: "end", exitPrice: 20000, barsHeld: 10, gross: -0.5, r: -0.05 });
    expect(report.roundTrips).toHaveLength(1);
    expect(exchange.tradeReport(1, iso(T0), iso(T0 + 5 * MIN)).roundTrips).toEqual([]);
    expect(exchange.positions(1, true)).toEqual([]);
  });
});

describe("no bar left before BACKTESTER_END", () => {
  // Data ends at T0+9 (the last bar closes at T0+10); END is an hour later.
  it("flattens at the last close at or before the clock", async () => {
    const { exchange, setNow } = await setup({ data: { NQ: [...flat(T0 - 5 * MIN, 10, 20000), ...flat(T0 + 5 * MIN, 5, 20004)] }, env: { BACKTESTER_END: iso(T0 + 60 * MIN) } });
    exchange.place(req({ size: 2 }));
    setNow(T0 + 30 * MIN);
    expect(exchange.place(req({ side: 0 }))).toMatchObject({ errorCode: 5, errorMessage: expect.stringMatching(/no bar left/) });
    expect(exchange.close(1, "BT.MNQ", 1)).toMatchObject({ success: true });
    expect(exchange.place(req({ side: 1 }))).toMatchObject({ success: true });
    expect(exchange.trades(1, iso(T0)).slice(1).map((t) => [t.price, t.creationTimestamp])).toEqual([[20004, iso(T0 + 30 * MIN)], [20004, iso(T0 + 30 * MIN)]]);
  });

  it("counts a clock exactly at END as ended", async () => {
    const { exchange, setNow } = await setup({ env: { BACKTESTER_END: iso(T0 + 10 * MIN) } });
    exchange.place(req());
    setNow(T0 + 10 * MIN); // a bar opens at END but would close after it
    expect(exchange.place(req({ side: 0 }))).toMatchObject({ errorCode: 5 });
    expect(exchange.close(1, "BT.MNQ", null)).toMatchObject({ success: true });
    expect(exchange.trades(1, iso(T0))[1]).toMatchObject({ price: 20000, creationTimestamp: iso(T0 + 10 * MIN) });
  });
});

describe("market data", () => {
  it("serves bars as of the clock, capped at endTime and BACKTESTER_END, and refuses second/month", async () => {
    const { exchange, setNow } = await setup({ env: { BACKTESTER_END: iso(T0 + 3 * MIN) } });
    const bars = (p = {}) => exchange.bars({ contractId: "BT.NQ", unit: "minute", unitNumber: 1, limit: 3, includePartialBar: false, ...p });
    expect(bars().map((b) => b.t)).toEqual([iso(T0 - 3 * MIN), iso(T0 - 2 * MIN), iso(T0 - MIN)]);
    expect(bars({ endTime: iso(T0 - 2 * MIN) }).map((b) => b.t)).toEqual([iso(T0 - 4 * MIN), iso(T0 - 3 * MIN), iso(T0 - 2 * MIN)]);
    expect(bars({ startTime: iso(T0 - 2 * MIN), limit: 10 })).toHaveLength(2);
    setNow(T0 + 30 * MIN);
    expect(bars().at(-1)?.t).toBe(iso(T0 + 2 * MIN));
    expect(() => bars({ unit: "second" })).toThrow(/1-minute data/);
    expect(() => bars({ unit: "month" })).toThrow(/1-minute data/);
    expect(() => bars({ contractId: "BT.ES" })).toThrow(/not found/);
  });

  it("quotes the last closed bar, or null when the market is closed", async () => {
    const prior = flat(Date.parse("2024-03-04T22:00:00Z"), 2, 19900);
    const { exchange, setNow } = await setup({ data: { NQ: [...prior, ...seq(Date.parse("2024-03-04T23:00:00Z"), [[20000, 20010, 19990, 20005]]), ...flat(T0 - 2 * MIN, 2, 20020)] } });
    expect(exchange.quote("BT.NQ")).toEqual({
      ageMs: 0,
      quote: { lastPrice: 20020, bestBid: 20020, bestAsk: 20020, change: 120, changePercent: 0.603, open: 20000, high: 20020, low: 19990, volume: 30, lastUpdated: iso(T0), timestamp: iso(T0) },
    });
    setNow(T0 + 16 * MIN);
    expect(exchange.quote("BT.NQ")).toBeNull();
    const empty = await setup({ now: T0, data: { NQ: flat(T0, 2, 1) } });
    expect(empty.exchange.quote("BT.NQ")).toBeNull();
  });
});

describe("state", () => {
  it("refuses a clock that moves backwards", async () => {
    const { exchange, setNow } = await setup();
    exchange.accounts();
    setNow(T0 - MIN);
    expect(() => exchange.accounts()).toThrow(/moved backwards/);
  });

  it("refuses an unknown account on reads", async () => {
    const { exchange } = await setup();
    expect(() => exchange.positions(9)).toThrow(/Account 9 not found/);
    expect(() => exchange.netPosition(9, "BT.MNQ")).toThrow(/not found/);
    expect(exchange.netPosition(1, "BT.MNQ")).toBe(0);
  });

  it("is shared by every process on one run, and separate across runs", async () => {
    const dir = tmp();
    const data = { NQ: flat(T0 - 10 * MIN, 30, 20000) };
    const a = await setup({ dir, data, now: T0 });
    const b = await setup({ dir });
    a.exchange.place(req());
    expect(b.exchange.positions(1)).toHaveLength(1);
    const other = new ReplayExchange(loadConfig({ ...envOf(a.config), BACKTESTER_RUN_ID: "other", BACKTESTER_STATE_DIR: `${dir}/state-other` }));
    expect(other.positions(1)).toEqual([]);
  });

  it("reads the clock only while holding the run's lock, and removes only its own lock", async () => {
    const { config } = await setup();
    const lock = `${config.statePath}.lock`;
    const held: boolean[] = [];
    const ex = new ReplayExchange(config, { now: () => { held.push(existsSync(lock)); return new Date(T0); } });
    ex.accounts();
    expect(held).toEqual([true]);
    expect(existsSync(lock)).toBe(false);
    // Another process took the lock over (a stale-lock sweep): this call must not delete it.
    const thief = new ReplayExchange(config, { now: () => { writeFileSync(lock, "someone-else"); return new Date(T0); } });
    thief.accounts();
    expect(readFileSync(lock, "utf8")).toBe("someone-else");
  });

  it("loads data files before taking the lock", async () => {
    const { config } = await setup();
    const lock = `${config.statePath}.lock`;
    const seen: boolean[] = [];
    class Spy extends BarStore {
      get(root: string) {
        seen.push(existsSync(lock));
        return super.get(root);
      }
    }
    const ex = new ReplayExchange(config, { store: new Spy(config.dataDir) });
    ex.quote("BT.MNQ");
    expect(seen[0]).toBe(false);
  });

  it("refuses a process whose fill settings differ from the run's", async () => {
    const dir = tmp();
    const a = await setup({ dir, data: defaultData(), now: T0 });
    a.exchange.accounts();
    const b = await setup({ dir, env: { BACKTESTER_SLIPPAGE_TICKS: "2" } });
    expect(() => b.exchange.accounts()).toThrow(/slippageTicks 2 vs 1/);
  });

  it("removes a stale lock and reports an unreadable state file", async () => {
    const { exchange, config } = await setup();
    exchange.accounts();
    writeFileSync(`${config.statePath}.lock`, "");
    utimesSync(`${config.statePath}.lock`, new Date(0), new Date(0));
    expect(exchange.accounts()).toHaveLength(1);
    writeFileSync(config.statePath, "{oops");
    expect(() => exchange.accounts()).toThrow(/unreadable/);
  });

  it("uses BACKTESTER_NOW when there is no clock file", () => {
    const dir = tmp();
    writeData(`${dir}/data`, { NQ: flat(T0 - 5 * MIN, 10, 20000) });
    const ex = new ReplayExchange(loadConfig({ BACKTESTER_DATA_DIR: `${dir}/data`, BACKTESTER_NOW: iso(T0), BACKTESTER_STATE_DIR: `${dir}/s` }));
    expect(ex.now().toISOString()).toBe(iso(T0));
    expect(ex.place(req())).toMatchObject({ success: true });
  });
});

function envOf(c: ReturnType<typeof loadConfig>): Record<string, string> {
  return { BACKTESTER_DATA_DIR: c.dataDir, BACKTESTER_CLOCK_FILE: c.clockFile as string, BACKTESTER_TRADING_ENABLED: "true" };
}
