import { describe, expect, it } from "vitest";
import { EMPTY_L1, FlowEngine, inferSide, type EngineCarry } from "../src/flowengine.js";
import { ofiEvent, recordOf, type MinuteBucket } from "../src/orderflow.js";

/** 2024-03-05 14:30Z (09:30 ET), as µs: minute M0, then M1. */
const M0 = Date.parse("2024-03-05T14:30:00Z");
const MIN = 60_000;
const us = (ms: number) => ms * 1000;
const q = (bid: number | null, bidSize: number | null, ask: number | null, askSize: number | null) => ({ bid, bidSize, ask, askSize });
const engine = (o: Partial<ConstructorParameters<typeof FlowEngine>[0]> = {}) => new FlowEngine({ tick: 0.25, ...o });
const rec = (e: FlowEngine, m: number) => recordOf(e.buckets.get(m) as MinuteBucket, true);

describe("trade side inference (history has no aggressor flag)", () => {
  const quote = q(99.75, 5, 100, 5);
  it("quote rule: at or above the ask a buy, at or below the bid a sell", () => {
    expect(inferSide(100, quote, -1)).toBe("buy");
    expect(inferSide(100.5, quote, -1)).toBe("buy");
    expect(inferSide(99.75, quote, 1)).toBe("sell");
    expect(inferSide(99.25, quote, 1)).toBe("sell");
  });
  it("inside the spread, the tick rule; no sign yet: no side", () => {
    const wide = q(99.5, 5, 100, 5);
    expect(inferSide(99.75, wide, 1)).toBe("buy");
    expect(inferSide(99.75, wide, -1)).toBe("sell");
    expect(inferSide(99.75, wide, 0)).toBeNull();
  });
  it("a locked or crossed quote says nothing: the tick rule decides", () => {
    expect(inferSide(100, q(100, 5, 100, 5), -1)).toBe("sell");
    expect(inferSide(100, q(100, 5, 100, 5), 1)).toBe("buy");
    expect(inferSide(100, q(100.25, 5, 99.75, 5), -1)).toBe("sell");
    expect(inferSide(100, q(100.25, 5, 99.75, 5), 0)).toBeNull();
  });
  it("a side not quoted yet is not used; the other side still is", () => {
    expect(inferSide(100, q(null, null, 100, 5), -1)).toBe("buy");
    expect(inferSide(99, q(99, 5, null, null), 1)).toBe("sell");
    expect(inferSide(100, EMPTY_L1, 0)).toBeNull();
    expect(inferSide(100, EMPTY_L1, -1)).toBe("sell");
  });

  it("uses the quote in force strictly before the print: a quote at the same µs doesn't count", () => {
    const e = engine();
    e.quoteState(us(M0), q(99.75, 5, 100, 5));
    e.trade(us(M0) + 10, 100.25, 1); // up-tick context: the next print at 100 is a down-tick
    e.quoteState(us(M0) + 20, q(99.75, 5, 100.25, 5)); // the ask moves up at the print's own µs
    e.trade(us(M0) + 20, 100, 4); // strictly before: ask 100 -> buy (with the same-µs quote: inside, a down-tick -> sell)
    e.quoteState(us(M0) + 30, q(100, 3, 100.5, 5));
    e.trade(us(M0) + 30, 100.25, 2); // strictly before: ask 100.25 -> buy
    e.trade(us(M0) + 40, 100, 7); // strictly before: bid 100 -> sell
    const r = rec(e, M0);
    expect([r.bv, r.sv]).toEqual([1 + 4 + 2, 7]);
  });

  it("the tick rule follows every print and keeps its sign on an unchanged price", () => {
    const e = engine();
    e.quoteState(us(M0), q(99, 5, 101, 5)); // wide: every print is inside
    e.trade(us(M0) + 1, 100, 1); // no previous print: no side
    e.trade(us(M0) + 2, 100.25, 2); // up: buy
    e.trade(us(M0) + 3, 100.25, 3); // zero tick: still buy
    e.trade(us(M0) + 4, 100, 4); // down: sell
    e.trade(us(M0) + 5, 100, 5); // zero tick: sell
    const r = rec(e, M0);
    expect([r.bv, r.sv, r.sidelessVolume, r.complete]).toEqual([5, 9, 1, false]);
  });

  it("a side given with the print (a converted live flag) is used as is, null included", () => {
    const e = engine();
    e.quoteState(us(M0), q(99.75, 5, 100, 5));
    e.trade(us(M0) + 1, 100, 3, "sell");
    e.trade(us(M0) + 2, 99.75, 2, "buy");
    e.trade(us(M0) + 3, 100, 1, null);
    e.trade(us(M0) + 4, 100, 1, "buy", true);
    const r = rec(e, M0);
    expect([r.bv, r.sv, r.sidelessVolume, r.badTimestamps, r.complete]).toEqual([3, 3, 1, 1, false]);
  });

  it("a reset (a session's start) forgets the quote and the tick rule", () => {
    const e = engine();
    e.quoteState(us(M0), q(99.75, 5, 100, 5));
    e.trade(us(M0) + 1, 100, 1);
    e.trade(us(M0) + 2, 100.25, 1);
    e.reset(us(M0 + MIN));
    e.trade(us(M0 + MIN) + 1, 100.5, 6); // no quote, no previous print: no side
    expect(rec(e, M0 + MIN)).toMatchObject({ bv: 0, sv: 0, sidelessVolume: 6, complete: false });
  });
});

describe("quote OFI (Cont, Kukanov & Stoikov) from L1 states", () => {
  it("ofiEvent by hand, and null with a missing price or size", () => {
    // bid up a tick with 3 (+3), ask unchanged at 100.5 size 8 -> 6 (-6 + 8 = +2): e = 3 + 2 = 5
    expect(ofiEvent(q(100, 4, 100.5, 8), q(100.25, 3, 100.5, 6))).toBe(5);
    // bid down (-4), ask down a tick with 2 (-2): -6
    expect(ofiEvent(q(100, 4, 100.5, 8), q(99.75, 9, 100.25, 2))).toBe(-4 - 2);
    // same prices: (qb - qb0) - (qa - qa0) = (7 - 4) - (5 - 8) = 6
    expect(ofiEvent(q(100, 4, 100.5, 8), q(100, 7, 100.5, 5))).toBe(6);
    expect(ofiEvent(q(100, 4, null, null), q(100, 7, 100.5, 5))).toBeNull();
  });

  it("sums the events per minute, one state per exchange timestamp, unchanged states skipped", () => {
    const e = engine();
    e.quoteState(us(M0) + 1, q(100, 4, null, null)); // one side only: no book yet
    e.quoteState(us(M0) + 2, q(100, 4, 100.5, 8)); // first full state: the chain starts, no event
    e.quoteState(us(M0) + 3, q(100, 7, 100.5, 8)); // +3
    // Two bid changes at one µs are one state: 100 (7) -> 100 (9) is +2; one by one, via 100.25 (5), it would be +5 - 5 = 0.
    e.quoteState(us(M0) + 4, q(100.25, 5, 100.5, 8));
    e.quoteState(us(M0) + 4, q(100, 9, 100.5, 8)); // +2
    e.quoteState(us(M0) + 5, q(100.25, 2, 100.5, 8)); // bid up a tick: +2
    e.quoteState(us(M0) + 6, q(100.25, 2, 100.5, 8)); // unchanged: nothing
    e.quoteState(us(M0 + MIN) + 1, q(100.25, 2, 100.25, 1)); // next minute: ask down a tick: -1
    e.advance(us(M0 + 2 * MIN));
    expect(rec(e, M0).ofiQuote).toBe(3 + 2 + 2);
    expect(rec(e, M0 + MIN).ofiQuote).toBe(-1);
  });

  it("is null in a minute without a book, 0 in a quiet minute with one", () => {
    const e = engine();
    e.quoteState(us(M0) + 1, q(100, 4, null, null));
    e.quoteState(us(M0 + MIN) + 1, q(100, 4, 100.5, 8));
    e.advance(us(M0 + 3 * MIN));
    expect(rec(e, M0).ofiQuote).toBeNull();
    expect(rec(e, M0 + MIN).ofiQuote).toBe(0);
    expect(rec(e, M0 + 2 * MIN).ofiQuote).toBe(0);
  });

  it("after a reset, a first state equal to the last one before it doesn't start the chain (live's L1 history)", () => {
    const e = engine();
    e.quoteState(us(M0) + 1, q(100, 4, 100.5, 8));
    e.reset(us(M0) + 2);
    e.quoteState(us(M0) + 3, q(100, 4, 100.5, 8)); // the same state as before the reset: not a new L1 state
    e.quoteState(us(M0) + 4, q(100, 6, 100.5, 8)); // starts the chain: no event (+2 if the equal state had started it)
    e.quoteState(us(M0) + 5, q(100, 7, 100.5, 8)); // +1
    e.advance(us(M0 + MIN));
    expect(rec(e, M0).ofiQuote).toBe(1);
  });

  it("a reset breaks the chain until two full states follow each other", () => {
    const e = engine();
    e.quoteState(us(M0) + 1, q(100, 4, 100.5, 8));
    e.reset(us(M0) + 2);
    e.quoteState(us(M0) + 3, q(100, 9, null, null)); // one side after the reset: not valid
    e.quoteState(us(M0) + 4, q(100, 9, 100.5, 8)); // the first valid state starts the chain again: no event (+5 without the reset)
    e.quoteState(us(M0) + 5, q(100.25, 1, 100.5, 8)); // bid up a tick: +1
    e.quoteState(us(M0) + 6, q(100.25, 3, 100.5, 8)); // +2
    e.advance(us(M0 + MIN));
    expect(rec(e, M0).ofiQuote).toBe(1 + 2);
  });
});

describe("the price-keyed book and its imbalance", () => {
  /** A book: touch 100 x 100.25 (sizes 10 / 6), L2 levels behind it. */
  function book(levels: Array<["bid" | "ask", number, number]>, o: Partial<ConstructorParameters<typeof FlowEngine>[0]> = {}) {
    const e = engine(o);
    e.quoteState(us(M0), q(100, 10, 100.25, 6));
    for (const [side, price, size] of levels) e.level(us(M0), side, price, size);
    e.advance(us(M0 + MIN));
    return rec(e, M0).bookImbalance;
  }

  it("level 1 is the L1 touch; levels behind it come from L2 strictly outside the touch, by price, not by rank", () => {
    // Bids 100 (touch, 10), 99.5 (20), 98 (5: a gap, still level 3); asks 100.25 (touch, 6), 101 (4).
    expect(book([["bid", 99.5, 20], ["bid", 98, 5], ["ask", 101, 4]])).toBe((35 - 10) / 45);
  });

  it("L2 levels at or through the touch are stale and ignored", () => {
    expect(book([["bid", 100, 99], ["bid", 100.25, 99], ["ask", 100.25, 99], ["ask", 100, 99]])).toBe((10 - 6) / 16);
  });

  it("takes the top 5 levels per side (the touch and 4 behind it)", () => {
    const bids: Array<["bid", number, number]> = [99.75, 99.5, 99.25, 99, 98.75, 98.5].map((p) => ["bid", p, 1]);
    // 10 + 4 x 1 = 14 against 6.
    expect(book(bids)).toBe((14 - 6) / 20);
  });

  it("a reset clears the L2 levels", () => {
    const e = engine();
    e.quoteState(us(M0), q(100, 10, 100.25, 6));
    e.level(us(M0), "bid", 99.75, 20);
    e.reset(us(M0) + 1);
    e.quoteState(us(M0) + 2, q(100, 10, 100.25, 6));
    e.advance(us(M0 + MIN));
    // 20 contracts on 99.75 for the first µs only: the rest of the minute is (10 - 6) / 16.
    expect(rec(e, M0).bookImbalance).toBeCloseTo(0.25, 6);
    expect(rec(e, M0).bookImbalance).toBeLessThan(0.2501);
  });

  it("a level the touch moves through is gone: it doesn't come back with its old size when the touch returns (live's Best rules)", () => {
    const e = engine();
    e.quoteState(us(M0), q(100, 10, 100.25, 6));
    e.level(us(M0), "bid", 99.5, 20);
    e.level(us(M0), "ask", 100.75, 30);
    e.quoteState(us(M0) + 1, q(99.25, 4, 100.25, 6)); // the bid falls through 99.5
    e.quoteState(us(M0) + 2, q(100, 10, 100.25, 6)); // and comes back: no 99.5 behind it
    e.quoteState(us(M0) + 3, q(100, 10, 101, 2)); // the ask rises through 100.75
    e.quoteState(us(M0 + 30_000), q(100, 10, 100.25, 6)); // and comes back: no 100.75 behind it
    e.advance(us(M0 + MIN));
    // 99.5 and 100.75 are gone; the touches moved onto keep their L1 sizes (99.25: 4, 101: 2), as live's Best rules set them.
    // From +3 µs to :30 the book is (10 + 4) x 2; from :30 to the minute's end (10 + 4) x (6 + 2) (the first 3 µs are negligible).
    expect(rec(e, M0).bookImbalance).toBeCloseTo(((12 / 16) * 30 + (6 / 22) * 30) / 60, 6);
    // The level at the touch itself stays (live keeps it): 99.75 behind a bid that moved up through nothing.
    const f = engine();
    f.quoteState(us(M0), q(100, 10, 100.25, 6));
    f.level(us(M0), "bid", 100, 10);
    f.quoteState(us(M0) + 1, q(100.25, 3, 100.5, 6)); // bid up a tick: 100 is now level 2
    f.advance(us(M0 + MIN));
    expect(rec(f, M0).bookImbalance).toBeCloseTo(7 / 19, 6);
    // The level the touch moves onto takes the L1 size (18, not its L2 20), as live's BestBid sets it; back behind the touch it counts with it.
    const g = engine();
    g.quoteState(us(M0), q(100, 10, 100.25, 6));
    g.level(us(M0), "bid", 100, 10);
    g.level(us(M0), "bid", 99.75, 20);
    g.quoteState(us(M0) + 1, q(99.75, 18, 100.25, 6));
    g.quoteState(us(M0) + 2, q(100, 10, 100.25, 6));
    g.advance(us(M0 + MIN));
    expect(rec(g, M0).bookImbalance).toBeCloseTo(22 / 34, 6);
    // The ask side, mirrored: 100.5 the touch moves onto keeps (with the L1 size), 100.75 above it is dropped only when moved through.
    const h = engine();
    h.quoteState(us(M0), q(100, 10, 100.25, 6));
    h.level(us(M0), "ask", 100.25, 6);
    h.level(us(M0), "ask", 100.5, 20);
    h.quoteState(us(M0) + 1, q(100, 10, 100.5, 18));
    h.quoteState(us(M0) + 2, q(100, 10, 100.25, 6));
    h.advance(us(M0 + MIN));
    expect(rec(h, M0).bookImbalance).toBeCloseTo((10 - 24) / 34, 6);
  });

  it("after a carry from a day without L2, the imbalance is null until an L2 level arrives", () => {
    const gap = engine({ book: false });
    gap.quoteState(us(M0), q(100, 10, 100.25, 6));
    const next = engine({ carry: gap.carry() });
    next.quoteState(us(M0 + MIN), q(100, 10, 100.25, 7));
    next.level(us(M0 + MIN + 30_000), "bid", 99.75, 4);
    next.advance(us(M0 + 2 * MIN));
    // Only from :30, when the first level arrived: (14 - 7) / 21.
    expect(rec(next, M0 + MIN).bookImbalance).toBeCloseTo(1 / 3, 12);
    expect(rec(next, M0 + MIN).ofiQuote).toBe(-1);
    // Across two carries: a day with L2 rows that never sent a level carries the wait on.
    const second = engine({ carry: engine({ carry: gap.carry() }).carry() });
    second.quoteState(us(M0 + 3 * MIN), q(100, 10, 100.25, 7));
    second.advance(us(M0 + 4 * MIN));
    expect(rec(second, M0 + 3 * MIN).bookImbalance).toBeNull();
    // A carry from a day with L2 keeps it.
    const full = engine();
    full.quoteState(us(M0), q(100, 10, 100.25, 6));
    const after = engine({ carry: full.carry() });
    after.advance(us(M0 + MIN));
    expect(rec(after, M0).bookImbalance).toBeCloseTo(4 / 16, 12);
  });

  it("removes a level far through the touch too (more than 4096 ticks away)", () => {
    const e = engine();
    e.level(us(M0), "bid", 3000, 5);
    e.level(us(M0), "ask", 1, 5);
    e.level(us(M0), "bid", 99.75, 4);
    e.quoteState(us(M0) + 1, q(100, 10, 100.25, 6));
    const c = e.carry();
    expect(c.bids).toEqual([[399, 4], [400, 10]]);
    expect(c.asks).toEqual([[401, 6]]);
  });

  it("a remove (size 0) clears the level", () => {
    expect(book([["ask", 100.5, 4], ["ask", 100.5, 0]])).toBe((10 - 6) / 16);
  });

  it("is time-weighted over the minute while the book is defined, split at minute boundaries", () => {
    const e = engine();
    e.quoteState(us(M0 + 15_000), q(100, 3, 100.25, 1)); // +0.5 from :15
    e.quoteState(us(M0 + 45_000), q(100, 1, 100.25, 3)); // -0.5 from :45
    e.quoteState(us(M0 + MIN + 30_000), q(100, 1, 100.25, 1)); // 0 from the next minute's :30
    e.advance(us(M0 + 2 * MIN));
    expect(rec(e, M0).bookImbalance).toBe((0.5 * 30 - 0.5 * 15) / 45);
    expect(rec(e, M0 + MIN).bookImbalance).toBe((-0.5 * 30 + 0) / 60);
  });

  it("is null before the book is valid; a side that empties later keeps it valid at ±1 (converted live depth)", () => {
    const e = engine();
    e.quoteState(us(M0), q(100, 3, null, null));
    e.quoteState(us(M0 + MIN), q(100, 3, 100.25, 1));
    e.quoteState(us(M0 + MIN + 30_000), q(100, 3, null, null));
    e.advance(us(M0 + 2 * MIN));
    expect(rec(e, M0).bookImbalance).toBeNull();
    expect(rec(e, M0 + MIN).bookImbalance).toBe((0.5 * 30 + 1 * 30) / 60);
  });

  it("without L2 (book: false) the levels behind the touch are ignored, carried ones too", () => {
    expect(book([["bid", 99.5, 20]], { book: false })).toBe((10 - 6) / 16);
    const first = engine();
    first.quoteState(us(M0), q(100, 10, 100.25, 6));
    first.level(us(M0), "bid", 99.5, 20);
    const carry = first.carry();
    const next = engine({ book: false, carry });
    next.quoteState(us(M0 + MIN), q(100, 10, 100.25, 6.5));
    next.advance(us(M0 + 2 * MIN));
    expect(rec(next, M0 + MIN).bookImbalance).toBe((10 - 6.5) / 16.5);
  });
});

describe("engine state", () => {
  it("carries everything over a day boundary: the book, the OFI chain, the tick rule, the imbalance", () => {
    const a = engine();
    a.quoteState(us(M0), q(100, 4, 100.25, 8));
    a.level(us(M0), "bid", 99.75, 6);
    a.trade(us(M0) + 1, 100.5, 1);
    a.advance(us(M0 + 30_000));
    const carry: EngineCarry = JSON.parse(JSON.stringify(a.carry()));
    expect(carry).toMatchObject({ seenBid: true, seenAsk: true, bids: [[399, 6], [400, 4]], asks: [[401, 8]], lastTrade: 100.5, lastTick: 0, imbFrom: M0 + 30_000 });
    const b = engine({ carry });
    b.trade(us(M0 + 40_000), 100.25, 2); // at the carried quote's ask: buy (a down-tick would say sell)
    b.quoteState(us(M0 + 50_000), q(100, 5, 100.25, 8)); // +1 on the carried chain
    b.advance(us(M0 + MIN));
    const r = rec(b, M0);
    expect([r.bv, r.ofiQuote]).toEqual([2, 1]);
    // The carried (10 - 8) / 18 from :30 (where the first engine stopped) to :50, then (11 - 8) / 19.
    expect(r.bookImbalance).toBeCloseTo(((2 / 18) * 20 + (3 / 19) * 10) / 30, 12);
  });

  it("refuses events out of time order", () => {
    const e = engine();
    e.trade(us(M0) + 5, 100, 1);
    expect(() => e.trade(us(M0) + 4, 100, 1)).toThrow(/out of time order/);
  });
});

describe("bar flow from minute records (orderflow.ts#barFlow)", () => {
  it("the bar imbalance is the plain mean of the minutes that have one; ofiQuote is null if any minute's is", async () => {
    const { barFlow, newBucket, recordOf: r } = await import("../src/orderflow.js");
    const a = newBucket(M0);
    a.imbArea = 0.5 * 60_000;
    a.imbMs = 60_000;
    a.ofiEvents = 1;
    a.ofiQuote = 4;
    const b = newBucket(M0 + MIN); // a complete minute without a book: imbalance and ofiQuote null
    const c = newBucket(M0 + 2 * MIN);
    c.imbArea = -0.1 * 30_000;
    c.imbMs = 30_000;
    const byMinute = new Map([a, b, c].map((x) => [x.t, r(x, true)]));
    expect(barFlow(byMinute, M0, 3, 10)).toMatchObject({ imbalance: (0.5 - 0.1) / 2, ofiQuote: null, complete: true });
    expect(barFlow(byMinute, M0 + 2 * MIN, 1, 10)).toMatchObject({ imbalance: -0.1, ofiQuote: 0 });
    expect(barFlow(byMinute, M0, 4, 10)).toMatchObject({ complete: false, bv: null });
  });
});
