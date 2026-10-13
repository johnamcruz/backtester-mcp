import { describe, expect, it } from "vitest";
import { EMPTY_QUOTE, keepRow, minuteBars, minuteIndex, normalizeL1, normalizeL2 } from "../src/events.js";

const T = Date.parse("2024-03-05T15:00:00Z"); // ms
const us = (ms: number) => ms * 1000;
const MIN = 60000;
const ALL: Array<[number, number]> = [[-Infinity, Infinity]];

/** Columns from [ms, ...rest] rows. */
function l1(rows: Array<[number, number, number, number]>) {
  return {
    ts: Float64Array.from(rows.map((r) => us(r[0]))),
    type: Float64Array.from(rows.map((r) => r[1])),
    price: Float64Array.from(rows.map((r) => r[2])),
    vol: Float64Array.from(rows.map((r) => r[3])),
  };
}

describe("L1 normalization", () => {
  it("turns bids, asks and trades into quote states and prints, skipping session statistics", () => {
    const r = normalizeL1(
      l1([
        [T, 0, 18000, 5], // bid
        [T + 1, 2, 18000.25, 2], // trade
        [T + 2, 1, 18000.25, 4], // ask
        [T + 3, 3, 0, 123456], // cumulative volume: skipped
        [T + 3, 9, 0, 250000], // open interest: skipped
        [T + 3, 0, 18000.25, 1], // bid, same µs as the stats: order kept
      ]),
      ALL,
    );
    expect(r.trades).toEqual([{ t: us(T + 1), price: 18000.25, size: 2 }]);
    expect(r.quotes).toEqual([
      { t: us(T), bid: 18000, bidSize: 5, ask: null, askSize: null },
      { t: us(T + 2), bid: 18000, bidSize: 5, ask: 18000.25, askSize: 4 },
      { t: us(T + 3), bid: 18000.25, bidSize: 1, ask: 18000.25, askSize: 4 },
    ]);
    expect(r.end).toEqual({ bid: 18000.25, bidSize: 1, ask: 18000.25, askSize: 4 });
    expect(r.kept).toBe(6);
  });

  it("skips every session statistics type (3-9) and unknown types: no trade, no quote change", () => {
    const rows: Array<[number, number, number, number]> = [[T, 0, 100, 1], [T, 1, 101, 2]];
    for (let k = 3; k <= 10; k++) rows.push([T + k, k, 500 + k, 9]);
    const r = normalizeL1(l1(rows), ALL);
    expect(r.trades).toEqual([]);
    expect(r.quotes).toHaveLength(2);
    expect(r.end).toEqual({ bid: 100, bidSize: 1, ask: 101, askSize: 2 });
    expect(r.kept).toBe(rows.length);
  });

  it("keeps µs precision and the data's order on ties", () => {
    const r = normalizeL1(l1([[T + 0.001, 2, 1, 1], [T + 0.001, 2, 2, 1], [T + 0.002, 2, 3, 1]]), ALL);
    expect(r.trades.map((x) => [x.t, x.price])).toEqual([[us(T) + 1, 1], [us(T) + 1, 2], [us(T) + 2, 3]]);
  });

  it("drops rows outside the ranges, starts from a carried state, and resets it at a new session", () => {
    const r = normalizeL1(
      l1([
        [T - 1, 2, 1, 1], // before the first range: dropped
        [T, 1, 18001, 3], // ask, in session 1 (bid carried in)
        [T + MIN, 2, 18001, 1], // in the break: dropped
        [T + 2 * MIN, 0, 18002, 2], // session 2: state reset, then this bid
      ]),
      [
        [T, T + MIN],
        [T + 2 * MIN, T + 3 * MIN],
      ],
      { bid: 18000, bidSize: 9, ask: null, askSize: null },
    );
    expect(r.trades).toEqual([]);
    expect(r.quotes).toEqual([
      { t: us(T), bid: 18000, bidSize: 9, ask: 18001, askSize: 3 },
      { t: us(T + 2 * MIN), bid: 18002, bidSize: 2, ask: null, askSize: null },
    ]);
    expect(r.kept).toBe(2);
  });

  it("can skip building the quote list and still return the end state", () => {
    const r = normalizeL1(l1([[T, 0, 5, 1], [T, 1, 6, 2]]), ALL, EMPTY_QUOTE, { quotes: false });
    expect(r.quotes).toEqual([]);
    expect(r.end).toEqual({ bid: 5, bidSize: 1, ask: 6, askSize: 2 });
  });

  it("keepRow tests a µs time against half-open ms ranges", () => {
    expect(keepRow(us(T), [[T, T + 1]])).toBe(true);
    expect(keepRow(us(T + 1), [[T, T + 1]])).toBe(false);
    expect(keepRow(us(T) - 1, [[T, T + 1]])).toBe(false);
  });
});

describe("L2 normalization", () => {
  it("maps side, act and rank; a remove's size is 0 with the raw vol kept", () => {
    const cols = {
      ts: Float64Array.from([us(T), us(T + 1), us(T + 2), us(T + 3), us(T + 4), us(T + 5)]),
      side: Float64Array.from([0, 1, 0, 1, 0, 7]),
      price: Float64Array.from([17999.75, 18000.5, 17999.75, 18000.5, 1, 1]),
      vol: Float64Array.from([10, 4, 12, 3, 1, 1]),
      depth: Float64Array.from([1, 2, 1, 2, 1, 1]),
      act: Float64Array.from([0, 0, 1, 2, 5, 0]),
    };
    expect(normalizeL2(cols, ALL)).toEqual([
      { t: us(T), side: "bid", price: 17999.75, size: 10, rawSize: 10, act: "add", rank: 1 },
      { t: us(T + 1), side: "ask", price: 18000.5, size: 4, rawSize: 4, act: "add", rank: 2 },
      { t: us(T + 2), side: "bid", price: 17999.75, size: 12, rawSize: 12, act: "update", rank: 1 },
      { t: us(T + 3), side: "ask", price: 18000.5, size: 0, rawSize: 3, act: "remove", rank: 2 },
    ]);
    expect(normalizeL2(cols, [[T + 1, T + 2]]).map((e) => e.t)).toEqual([us(T + 1)]);
  });
});

describe("one-minute bars from trades", () => {
  const tr = (ms: number, price: number, size = 1) => ({ t: us(ms), price, size });

  it("builds OHLCV per UTC minute, half-open, only for minutes with trades", () => {
    const b = minuteBars([
      tr(T, 100),
      tr(T + 10_000, 101.5, 2),
      tr(T + 20_000, 99.25, 3),
      tr(T + MIN - 0.001, 100.75, 4), // the last µs of the minute
      tr(T + MIN, 102), // exactly on the next minute: the next bar
      tr(T + 3 * MIN + 5, 98, 7), // minute 2 is empty: no bar
    ]);
    expect(b).toEqual({
      t: [T, T + MIN, T + 3 * MIN],
      o: [100, 102, 98],
      h: [101.5, 102, 98],
      l: [99.25, 102, 98],
      c: [100.75, 102, 98],
      v: [10, 1, 7],
    });
    expect(minuteBars([])).toEqual({ t: [], o: [], h: [], l: [], c: [], v: [] });
  });

  it("refuses trades out of time order", () => {
    expect(() => minuteBars([tr(T + MIN, 1), tr(T, 1)])).toThrow(/out of time order/);
  });

  it("buckets by the µs: the last µs of a minute and the first of the next fall in different bars, also across hours and days", () => {
    const H = Date.parse("2024-03-05T23:59:00Z");
    const b = minuteBars([
      { t: us(H) + 59_999_999, price: 1, size: 1 },
      { t: us(H) + 60_000_000, price: 2, size: 1 },
      { t: us(H) + 60_000_001, price: 3, size: 1 },
    ]);
    expect(b.t).toEqual([H, H + MIN]);
    expect(b.c).toEqual([1, 3]);
    expect(b.v).toEqual([1, 2]);
  });

  it("indexes the first row of each minute", () => {
    expect(minuteIndex(Float64Array.from([us(T) - 1, us(T)]))).toEqual([
      [T - MIN, 0],
      [T, 1],
    ]);
    expect(minuteIndex(Float64Array.from([us(T), us(T + 5), us(T + MIN), us(T + 3 * MIN), us(T + 3 * MIN + 1)]))).toEqual([
      [T, 0],
      [T + MIN, 2],
      [T + 3 * MIN, 3],
    ]);
  });
});
