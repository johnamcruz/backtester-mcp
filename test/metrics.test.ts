import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/bars.js";
import { ORDER_TYPES } from "../src/enums.js";
import { STATUS } from "../src/fills.js";
import { roundTrips, type MetricOrder, type TickSpec } from "../src/metrics.js";
import type { Trade } from "../src/performance.js";
import { MIN, T0, csv, iso, seq } from "./helpers.js";

// Hand-computed, tick-correct examples. Tick specs (USD per tick per contract):
const MNQ: TickSpec = { tickSize: 0.25, tickValue: 0.5 }; // $2 per point
const NQ: TickSpec = { tickSize: 0.25, tickValue: 5 }; // $20 per point
const ES: TickSpec = { tickSize: 0.25, tickValue: 12.5 };
const YM: TickSpec = { tickSize: 1, tickValue: 5 };
const RTY: TickSpec = { tickSize: 0.1, tickValue: 5 };

const t = (k: number) => T0 + k * MIN; // bar k opens at t(k) and closes at t(k + 1)
const bars = (ohlc: Array<[number, number, number, number]>) => parseCsv(csv(seq(T0, ohlc)));

let nextId = 1;
const order = (p: Partial<MetricOrder>): MetricOrder => ({
  id: nextId++, side: 0, type: ORDER_TYPES.market, role: "order", stopPrice: null, stopLossBracket: null,
  placedAt: T0, updatedAt: T0, status: STATUS.filled, ...p,
});
const fill = (id: number, o: MetricOrder, side: 0 | 1, size: number, price: number, time: number, pnl: number | null, fees = 0.37 * size): Trade => ({
  id, contractId: "BT.X", creationTimestamp: iso(time), price, profitAndLoss: pnl, fees, side, size, voided: false, orderId: o.id,
});

describe("round trips: stop and target exits", () => {
  it("MNQ long stopped out by its bracket: MAE at the stop fill, MFE from the bars held whole, R from the bracket", () => {
    // Market buy at bar 0's open 100 + 1 tick = 100.25; bracket stop 8 ticks -> 98.25 ($4 risk).
    const entry = order({ stopLossBracket: { ticks: 8, type: ORDER_TYPES.stop } });
    // Bar 2 trades through the stop: it fills at 98.25 less a tick = 98.00, stamped at bar 2's close.
    const sl = order({ role: "sl", side: 1, type: ORDER_TYPES.stop, stopPrice: 98.25, parentId: entry.id } as Partial<MetricOrder>);
    const b = bars([[100, 102, 99, 101], [101, 103, 100, 102], [101.5, 101.75, 97, 97.5]]);
    const fills = [fill(1, entry, 0, 1, 100.25, t(0), null), fill(2, sl, 1, 1, 98, t(3), -4.5)];
    const r = roundTrips("BT.MNQ", fills, [entry, sl], b, MNQ, t(5));
    expect(r.open).toBeNull();
    expect(r.closed).toEqual([
      {
        id: 1, contractId: "BT.MNQ", direction: "long", open: false,
        entryTime: iso(t(0)), entryPrice: 100.25, entrySize: 1, averageEntryPrice: 100.25, maxSize: 1, closedSize: 1,
        exitTime: iso(t(3)), exitPrice: 98, exitFillId: 2, reason: "stop", partialExits: 0, reversed: false,
        initialStop: 98.25, risk: 2, riskDollars: 4,
        // Worst: the stop fill, 98.00 - 100.25 = -2.25 points = -9 ticks = -$4.50 = -1.125R.
        maePoints: -2.25, maeTicks: -9, maeDollars: -4.5, maeR: -1.125, maeTime: iso(t(3)),
        // Best: bar 1's high 103 - 100.25 = 2.75 points = 11 ticks = $5.50 = 1.375R (bar 2's high is not counted: it is the exit bar).
        mfePoints: 2.75, mfeTicks: 11, mfeDollars: 5.5, mfeR: 1.375, mfeTime: iso(t(1)),
        barsHeld: 2, gross: -4.5, fees: 0.74, net: -5.24, r: -1.125, rNet: -1.31,
      },
    ]);
    expect(r.fills.get(1)).toEqual({ roundTripId: 1 });
    expect(r.fills.get(2)).toEqual({ roundTripId: 1, exitReason: "stop" });
  });

  it("NQ short, 2 contracts, hits its target: the exit bar counts only its open and the fill", () => {
    // Sell 2 at 200.25 - 1 tick = 200.00; stop 12 ticks -> 203.00: risk 3 points x $20 x 2 = $120.
    const entry = order({ side: 1, stopLossBracket: { ticks: 12, type: ORDER_TYPES.stop } });
    const tp = order({ role: "tp", side: 0, type: ORDER_TYPES.limit });
    const b = bars([[200.25, 201, 199, 199.5], [199.5, 199.75, 194.5, 195]]);
    // Bar 1's low reaches the 195.00 target: +20 ticks x $5 x 2 = $200.
    const fills = [fill(1, entry, 1, 2, 200, t(0), null, 2.48), fill(2, tp, 0, 2, 195, t(2), 200, 2.48)];
    const [trip] = roundTrips("BT.NQ", fills, [entry, tp], b, NQ, t(2)).closed;
    expect(trip).toMatchObject({
      direction: "short", reason: "target", initialStop: 203, risk: 3, riskDollars: 120,
      // Bar 0's high 201: -1 point = -4 ticks = -$40 for 2 contracts = -0.333R.
      maePoints: -1, maeTicks: -4, maeDollars: -40, maeR: -0.333, maeTime: iso(t(0)),
      // The target fill: +5 points = 20 ticks = $200 = 1.667R (the harness would also count bar 1's low 194.5: 1.833R).
      mfePoints: 5, mfeTicks: 20, mfeDollars: 200, mfeR: 1.667, mfeTime: iso(t(2)),
      barsHeld: 1, gross: 200, fees: 4.96, net: 195.04, r: 1.667, rNet: 1.625,
    });
  });

  it("names a moved stop and a trailing stop 'trail', a limit 'target', a client market order 'close'", () => {
    const b = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100]]);
    const run = (exit: MetricOrder, price: number, time: number) => {
      const entry = order({ stopLossBracket: { ticks: 4, type: ORDER_TYPES.stop } }); // stop 99
      return roundTrips("BT.MNQ", [fill(1, entry, 0, 1, 100, t(0), null), fill(2, exit, 1, 1, price, time, 0)], [entry, exit], b, MNQ, t(4)).closed[0].reason;
    };
    expect(run(order({ role: "sl", side: 1, type: ORDER_TYPES.stop, stopPrice: 99 }), 99, t(2))).toBe("stop");
    // Moved with modify_order (its placement price is recorded first): trail. A different price never modified: stop.
    expect(run(order({ role: "sl", side: 1, type: ORDER_TYPES.stop, stopPrice: 100, stopAt: [[t(0), 99], [t(1), 100]] }), 100, t(2))).toBe("trail");
    expect(run(order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 98, stopAt: [[t(0), 98]] }), 98, t(2))).toBe("stop");
    expect(run(order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 100 }), 100, t(2))).toBe("stop");
    // An add's own stop-loss leg (placed later, never moved) after the entry's leg was moved away: stop, not a replacement.
    const e0 = order({ stopLossBracket: { ticks: 4, type: ORDER_TYPES.stop } });
    const leg = order({ role: "sl", side: 1, type: ORDER_TYPES.stop, stopPrice: 99.5, parentId: e0.id, placedAt: t(0), status: STATUS.cancelled, updatedAt: t(3), stopAt: [[t(0), 99], [t(1), 99.5]] });
    const add = order({ placedAt: t(2) });
    const addLeg = order({ role: "sl", side: 1, type: ORDER_TYPES.stop, stopPrice: 98, parentId: add.id, placedAt: t(2) });
    const legFills = [fill(1, e0, 0, 1, 100, t(0), null), fill(2, add, 0, 1, 100, t(2), null), fill(3, addLeg, 1, 2, 98, t(3), -8)];
    expect(roundTrips("BT.MNQ", legFills, [e0, leg, add, addLeg], b, MNQ, t(4)).closed[0]).toMatchObject({ initialStop: 99, reason: "stop" });
    expect(run(order({ role: "sl", side: 1, type: ORDER_TYPES.trailing_stop, stopPrice: 99 }), 99, t(2))).toBe("trail");
    expect(run(order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 99 }), 99, t(2))).toBe("stop");
    expect(run(order({ side: 1, type: ORDER_TYPES.limit }), 100, t(2))).toBe("target");
    expect(run(order({ side: 1 }), 100, t(2))).toBe("close");
    expect(run(order({ role: "close", side: 1 }), 100, t(2))).toBe("close");
    expect(run(order({ side: 1, endOfWindow: true }), 100, t(4))).toBe("end");
    const entry = order({});
    const lost: Trade[] = [fill(1, entry, 0, 1, 100, t(0), null), { ...fill(2, entry, 1, 1, 100, t(2), 0), orderId: 999 }];
    expect(roundTrips("BT.MNQ", lost, [entry], b, MNQ, t(4)).closed[0].reason).toBe("other");
  });
});

describe("round trips: partials, adds, reversals", () => {
  it("a partial exit stays in the round trip: P&L-based excursions, 'partial' on the scale-out fill", () => {
    // Long 2 MNQ at 100.00, no stop (R null). Sell 1 at a 102 limit inside bar 1 (+8 ticks = $4); close 1 at bar 3's open: 102.75 - 1 tick = 102.50 (+10 ticks = $5).
    const entry = order({});
    const tp = order({ side: 1, type: ORDER_TYPES.limit });
    const close = order({ role: "close", side: 1 });
    const b = bars([[100, 101, 99.5, 100.5], [100.5, 102.5, 100, 102], [102, 103, 101, 102.5], [102.75, 103, 102.5, 103]]);
    const fills = [fill(1, entry, 0, 2, 100, t(0), null), fill(2, tp, 1, 1, 102, t(2), 4), fill(3, close, 1, 1, 102.5, t(3), 5)];
    const r = roundTrips("BT.MNQ", fills, [entry, tp, close], b, MNQ, t(4));
    expect(r.closed[0]).toMatchObject({
      entrySize: 2, maxSize: 2, closedSize: 2, exitPrice: 102.25, partialExits: 1, reason: "close",
      initialStop: null, risk: null, riskDollars: null, maeR: null, mfeR: null, r: null, rNet: null,
      // Bar 0's low 99.5 with 2 open: -0.5 points x $2 x 2 = -$2 (= -2 ticks per contract).
      maeDollars: -2, maeTicks: -2, maePoints: -0.5, maeTime: iso(t(0)),
      // Bar 2's high 103 with 1 open after the partial: $4 realized + 3 points x $2 = $10, i.e. 20 ticks per contract open.
      mfeDollars: 10, mfeTicks: 20, mfePoints: 5, mfeTime: iso(t(2)),
      // Bars 0, 1 (held from its open to its close, the partial inside it) and 2.
      barsHeld: 3, gross: 9, fees: 1.48, net: 7.52,
    });
    expect([...r.fills]).toEqual([[1, { roundTripId: 1 }], [2, { roundTripId: 1, exitReason: "partial" }], [3, { roundTripId: 1, exitReason: "close" }]]);
  });

  it("an add averages the entry like the fill engine; excursions follow the bigger position", () => {
    // Long 1 at 100 (bar 0 open), add 1 at 101 (bar 1 open): average 100.5. Bar 1: low 100 -> -0.5 x $2 x 2 = -$2; high 102 -> +1.5 x $2 x 2 = $6.
    const a = order({});
    const add = order({});
    const out = order({ role: "close", side: 1 });
    const b = bars([[100, 101, 100, 101], [101, 102, 100, 101.5], [101.5, 101.5, 101.5, 101.5]]);
    const fills = [fill(1, a, 0, 1, 100, t(0), null), fill(2, add, 0, 1, 101, t(1), null), fill(3, out, 1, 2, 101.5, t(2), 2)];
    const [trip] = roundTrips("BT.MNQ", fills, [a, add, out], b, MNQ, t(3)).closed;
    expect(trip).toMatchObject({ entryPrice: 100, entrySize: 1, averageEntryPrice: 100.5, maxSize: 2, maeDollars: -2, maePoints: -0.5, mfeDollars: 6, mfePoints: 1.5, mfeTime: iso(t(1)), barsHeld: 2, gross: 2 });
  });

  it("a reversal ends one round trip and opens the next with the part beyond flat; fees split by size", () => {
    // Long 1 MNQ at 100.00 with a client sell stop at 98 working (placed before; risk 8 ticks = $4).
    const stop = order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 98, placedAt: T0 - 30000, updatedAt: t(2), status: STATUS.cancelled });
    const entry = order({});
    // Sell 2 at bar 2's open 101 - 1 tick = 100.75: closes the long (+3 ticks = $1.50) and opens a short of 1 at 100.75.
    const rev = order({ side: 1 });
    // A buy limit at 100.25 fills inside bar 3: +2 ticks = $1.
    const tp = order({ side: 0, type: ORDER_TYPES.limit });
    const b = bars([[100, 101, 99.75, 100.5], [100.5, 100.75, 100.25, 100.5], [101, 101.5, 100, 100.5], [100.5, 100.75, 100.25, 100.5]]);
    const fills = [fill(1, entry, 0, 1, 100, t(0), null), fill(2, rev, 1, 2, 100.75, t(2), 1.5), fill(3, tp, 0, 1, 100.25, t(4), 1)];
    const r = roundTrips("BT.MNQ", fills, [stop, entry, rev, tp], b, MNQ, t(5));
    expect(r.closed).toHaveLength(2);
    expect(r.closed[0]).toMatchObject({
      id: 1, direction: "long", reason: "close", reversed: true, exitFillId: 2, initialStop: 98, riskDollars: 4,
      mfeDollars: 2, mfeR: 0.5, mfeTime: iso(t(0)), maeDollars: -0.5, maeR: -0.125, barsHeld: 2, gross: 1.5, fees: 0.74, r: 0.375,
    });
    expect(r.closed[1]).toMatchObject({
      id: 2, direction: "short", entryPrice: 100.75, entrySize: 1, entryTime: iso(t(2)), reason: "target", reversed: false,
      initialStop: null, maeR: null,
      // Bar 2 (held whole from the reversal at its open): high 101.5 -> -0.75 points = -$1.50; low 100 -> +$1.50.
      maeDollars: -1.5, maeTime: iso(t(2)), mfeDollars: 1.5, mfeTime: iso(t(2)),
      barsHeld: 1, gross: 1, fees: 0.74, net: 0.26,
    });
    expect(r.fills.get(2)).toEqual({ roundTripId: 1, exitReason: "close" });
    expect(r.fills.get(3)).toEqual({ roundTripId: 2, exitReason: "target" });
  });
});

describe("round trips: no lookahead", () => {
  it("an open round trip counts only bars closed at or before the cutoff", () => {
    const entry = order({ stopLossBracket: { ticks: 8, type: ORDER_TYPES.stop } });
    // Bar 2 is still forming at the cutoff (t(2) + 30 s): its 110 high must not count.
    const b = bars([[100, 101, 99, 100.5], [100.5, 102, 100, 101], [101, 110, 90, 101]]);
    const r = roundTrips("BT.MNQ", [fill(1, entry, 0, 1, 100.25, t(0), null)], [entry], b, MNQ, t(2) + 30000);
    expect(r.closed).toEqual([]);
    expect(r.open).toMatchObject({
      open: true, exitTime: null, exitPrice: null, exitFillId: null, reason: null, r: null, rNet: null, gross: 0, fees: 0.37,
      barsHeld: 2, mfePoints: 1.75, mfeR: 0.875, mfeTime: iso(t(1)), maePoints: -1.25, maeR: -0.625, maeTime: iso(t(0)),
    });
  });

  it("a fill inside a bar uses none of that bar's range: an intrabar entry starts from its fill", () => {
    // A buy stop at 101 fills inside bar 0 (stamped at its close); bar 0's 105 high and 99 low came before or after it: unknown.
    const entry = order({ type: ORDER_TYPES.stop, stopPrice: 101 });
    const b = bars([[100, 105, 99, 101], [101, 102, 100.5, 101.5]]);
    const r = roundTrips("BT.MNQ", [fill(1, entry, 0, 1, 101.25, t(1), null)], [entry], b, MNQ, t(2));
    expect(r.open).toMatchObject({ entryTime: iso(t(1)), barsHeld: 1, mfePoints: 0.75, mfeTime: iso(t(1)), maePoints: -0.75 });
  });

  it("an end-of-window fill comes after every closed bar", () => {
    const entry = order({ stopLossBracket: { ticks: 4, type: ORDER_TYPES.stop } }); // stop 99, $2 risk
    const end = order({ side: 1, endOfWindow: true });
    const b = bars([[100, 100.5, 99.5, 100], [100, 101, 100, 100.75], [100.75, 100.75, 100.75, 100.75]]);
    // Window ends at t(3): the last close 100.75 (+3 ticks = $1.50).
    const r = roundTrips("BT.MNQ", [fill(1, entry, 0, 1, 100, t(0), null), fill(2, end, 1, 1, 100.75, t(3), 1.5)], [entry, end], b, MNQ, t(3));
    expect(r.closed[0]).toMatchObject({ reason: "end", barsHeld: 3, mfeR: 1, maeR: -0.5, r: 0.75 });
  });

  it("without data, only fills count", () => {
    const entry = order({});
    const out = order({ role: "close", side: 1 });
    const r = roundTrips("BT.MNQ", [fill(1, entry, 0, 1, 100, t(0), null), fill(2, out, 1, 1, 99, t(3), -2)], [entry, out], null, MNQ, t(5));
    expect(r.closed[0]).toMatchObject({ barsHeld: 0, maeDollars: -2, mfeDollars: 0, mfeTime: iso(t(0)) });
  });
});

describe("round trips: initial stop", () => {
  const b = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100]]);
  const tripWith = (stops: MetricOrder[]) => {
    const entry = order({ placedAt: t(0) });
    return roundTrips("BT.MNQ", [fill(1, entry, 0, 1, 100, t(0), null)], [...stops, entry], b, MNQ, t(3)).open;
  };
  it("takes a stop placed within the minute after the entry, at its price then", () => {
    expect(tripWith([order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 99, placedAt: t(0) + 20000, status: STATUS.open })])).toMatchObject({ initialStop: 99, riskDollars: 2 });
    // Moved to 99.5 a minute later: the initial stop stays 99.
    const moved = order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 99.5, placedAt: t(0) + 20000, status: STATUS.open, stopAt: [[t(0) + 20000, 99], [t(1) + 10000, 99.5]] });
    expect(tripWith([moved])).toMatchObject({ initialStop: 99 });
    // Placed before the entry and moved before it: the price at the entry.
    const early = order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 98, placedAt: t(0) - 50000, status: STATUS.open, stopAt: [[t(0) - 50000, 97], [t(0) - 10000, 98]] });
    expect(tripWith([early])).toMatchObject({ initialStop: 98, risk: 2, riskDollars: 4 });
  });
  it("takes the closest of several stops (a leftover far stop, scale-out stops)", () => {
    const far = order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 90, placedAt: t(0) - 50000, status: STATUS.open });
    const near = order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 99, placedAt: t(0) + 10000, status: STATUS.open });
    const mid = order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 98, placedAt: t(0) + 20000, status: STATUS.open });
    expect(tripWith([far, near, mid])).toMatchObject({ initialStop: 99, riskDollars: 2 });
  });
  it("ignores a stop filled or cancelled at the very moment of the entry (the previous trade's)", () => {
    expect(tripWith([order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 99, placedAt: t(0) - 50000, updatedAt: t(0), status: STATUS.filled })])?.initialStop).toBeNull();
    expect(tripWith([order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 99, placedAt: t(0) - 50000, updatedAt: t(0), status: STATUS.cancelled })])?.initialStop).toBeNull();
    // Cancelled later (while protecting this trade): counts.
    expect(tripWith([order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 99, placedAt: t(0) - 50000, updatedAt: t(0) + 1, status: STATUS.cancelled })])?.initialStop).toBe(99);
  });
  it("ignores stops placed later, gone before the entry, on the wrong side of it, or on the opening side", () => {
    expect(tripWith([order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 99, placedAt: t(1), status: STATUS.open })])?.initialStop).toBeNull();
    expect(tripWith([order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 99, placedAt: t(0) - 50000, updatedAt: t(0) - 1, status: STATUS.cancelled })])?.initialStop).toBeNull();
    expect(tripWith([order({ side: 1, type: ORDER_TYPES.stop, stopPrice: 100.5, placedAt: t(0), status: STATUS.open })])?.initialStop).toBeNull();
    expect(tripWith([order({ side: 0, type: ORDER_TYPES.stop, stopPrice: 99, placedAt: t(0), status: STATUS.open })])?.initialStop).toBeNull();
    expect(tripWith([order({ side: 1, type: ORDER_TYPES.limit, placedAt: t(0), status: STATUS.open })])?.initialStop).toBeNull();
  });
});

describe("round trips: tick arithmetic per contract", () => {
  // One bar held whole, then a market exit at the next bar's open (prices already include slippage).
  const cases: Array<[string, TickSpec, number, number, number, [number, number], number, Record<string, number>]> = [
    // ES long 1 at 5000.00, stop 16 ticks (4996.00, $200). High 5003.25 = +13 ticks = $162.50; low 4998.50 = -6 ticks = -$75; exit 5002.00 = +8 ticks = $100.
    ["ES", ES, 1, 5000, 16, [5003.25, 4998.5], 5002, { mfeTicks: 13, mfeDollars: 162.5, mfeR: 0.813, maeTicks: -6, maeDollars: -75, maeR: -0.375, gross: 100, r: 0.5, riskDollars: 200 }],
    // YM ($5 per 1.0) long 1 at 39000, stop 20 ticks (38980, $100). High 39015 = $75; low 38990 = -$50; exit 39010 = $50.
    ["YM", YM, 1, 39000, 20, [39015, 38990], 39010, { mfeTicks: 15, mfeDollars: 75, mfeR: 0.75, maeTicks: -10, maeDollars: -50, maeR: -0.5, gross: 50, r: 0.5, riskDollars: 100 }],
    // RTY ($5 per 0.1) long 2 at 2050.0, stop 20 ticks (2048.0, $200). High 2051.3 = 13 ticks x $5 x 2 = $130; low 2049.2 = -$80; exit 2050.5 = $50.
    ["RTY", RTY, 2, 2050, 20, [2051.3, 2049.2], 2050.5, { mfeTicks: 13, mfePoints: 1.3, mfeDollars: 130, mfeR: 0.65, maeTicks: -8, maePoints: -0.8, maeDollars: -80, maeR: -0.4, gross: 50, r: 0.25, riskDollars: 200 }],
    // MNQ long 3 at 18000.00, stop 40 ticks (17990.00, 40 x $0.50 x 3 = $60). High 18004.50 = 18 ticks x $1.50 = $27; low 17995.25 = -19 ticks = -$28.50; exit 18002.00 = 8 ticks = $12.
    ["MNQ", MNQ, 3, 18000, 40, [18004.5, 17995.25], 18002, { mfeTicks: 18, mfeDollars: 27, mfeR: 0.45, maeTicks: -19, maeDollars: -28.5, maeR: -0.475, gross: 12, r: 0.2, riskDollars: 60 }],
  ];
  for (const [name, spec, size, px, stopTicks, [hi, lo], exit, want] of cases) {
    it(`${name}: points, ticks, dollars and R`, () => {
      const entry = order({ stopLossBracket: { ticks: stopTicks, type: ORDER_TYPES.stop } });
      const out = order({ role: "close", side: 1 });
      const b = bars([[px, hi, lo, exit], [exit, exit, exit, exit]]);
      const ticks = Math.round((exit - px) / spec.tickSize);
      const fills = [fill(1, entry, 0, size, px, t(0), null), fill(2, out, 1, size, exit, t(1), ticks * spec.tickValue * size)];
      expect(roundTrips(`BT.${name}`, fills, [entry, out], b, spec, t(2)).closed[0]).toMatchObject({ ...want, barsHeld: 1 });
    });
  }
});

describe("round trips: fills on arrival (marketFill now)", () => {
  // Bar 1 ranges 95..105; bars 0 and 2 are quiet.
  const b = () => bars([[100, 100.5, 99.5, 100], [100, 105, 95, 100], [100, 100.5, 99.5, 100], [100, 100, 100, 100]]);

  it("an entry and an exit inside bars: neither bar's range counts, only the exit bar's open and the fills", () => {
    // Buy on arrival at t(1)+30s at bar 1's open 100 + 1 tick; sell on arrival at t(2)+20s at bar 2's open 100 - 1 tick.
    const entry = order({ arrival: true, placedAt: t(1) + 30000, updatedAt: t(1) + 30000 });
    const exit = order({ arrival: true, side: 1, role: "close", placedAt: t(2) + 20000, updatedAt: t(2) + 20000 });
    const fills = [fill(1, entry, 0, 1, 100.25, t(1) + 30000, null), fill(2, exit, 1, 1, 99.75, t(2) + 20000, -0.5)];
    const [trip] = roundTrips("BT.MNQ", fills, [entry, exit], b(), MNQ, t(4)).closed;
    // Bar 1 (95..105) not at all; bar 2: its open 100 (-1 tick, $0.50) and the fill 99.75 (-2 ticks, $1).
    expect(trip).toMatchObject({ entryTime: iso(t(1) + 30000), exitTime: iso(t(2) + 20000), maeDollars: -1, mfeDollars: 0, barsHeld: 0, reason: "close" });
  });

  it("a fill on arrival exactly at a bar's open is at that open: the bar's range after it counts", () => {
    const entry = order({ arrival: true, placedAt: t(1), updatedAt: t(1) });
    const fills = [fill(1, entry, 0, 1, 100.25, t(1), null)];
    const r = roundTrips("BT.MNQ", fills, [entry], b(), MNQ, t(2));
    // Bar 1 held whole: high 105 (+19 ticks, $9.50), low 95 (-21 ticks, $10.50).
    expect(r.open).toMatchObject({ mfeDollars: 9.5, maeDollars: -10.5, barsHeld: 1 });
  });

  it("a join filled on arrival exactly at a bar's open is at that open, not inside the bar before", () => {
    // Long at t(1)'s open 100.25; a join_ask sell fills on arrival exactly at t(2), at 100.
    const entry = order({ arrival: true, placedAt: t(1), updatedAt: t(1) });
    const exit = order({ arrival: true, side: 1, type: ORDER_TYPES.join_ask, placedAt: t(2), updatedAt: t(2) });
    const fills = [fill(1, entry, 0, 1, 100.25, t(1), null), fill(2, exit, 1, 1, 100, t(2), -0.5)];
    const [trip] = roundTrips("BT.MNQ", fills, [entry, exit], b(), MNQ, t(4)).closed;
    // Bar 1 held whole before the exit: high 105 (+19 ticks, $9.50), low 95 (-21 ticks, $10.50).
    expect(trip).toMatchObject({ mfeDollars: 9.5, maeDollars: -10.5, barsHeld: 1, reason: "target" });
  });

  it("an add inside the bar in progress at the cutoff reads nothing of that bar but its open", () => {
    const first = order({ placedAt: t(1), updatedAt: t(1) });
    const add = order({ arrival: true, placedAt: t(1) + 30000, updatedAt: t(1) + 30000 });
    const fills = [fill(1, first, 0, 1, 100.25, t(1), null), fill(2, add, 0, 1, 100.25, t(1) + 30000, null)];
    const r = roundTrips("BT.MNQ", fills, [first, add], b(), MNQ, t(1) + 30000);
    expect(r.open).toMatchObject({ mfeDollars: 0, maeDollars: 0, barsHeld: 0 });
  });
});
