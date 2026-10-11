import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BarStore, aggregate, bucketOf, parseCsv, parseTimestamp } from "../src/bars.js";
import { MIN, T0, csv, flat, iso, seq, tmp, writeData } from "./helpers.js";

describe("CSV", () => {
  it("parses timestamps as UTC in the data's and ISO formats", () => {
    expect(parseTimestamp("2024-03-05 15:00:00+00:00")).toBe(T0);
    expect(parseTimestamp("2024-03-05T15:00:00Z")).toBe(T0);
    expect(parseTimestamp("2024-03-05T15:00")).toBe(T0);
    expect(parseTimestamp("2024-03-05T10:00:00-05:00")).toBe(T0);
    expect(() => parseTimestamp("yesterday")).toThrow(/bad timestamp/);
  });

  it("reads columns, skips duplicate rows, and rejects bad files", () => {
    const s = parseCsv(csv([[T0, 1, 2, 0.5, 1.5, 7], [T0, 9, 9, 9, 9], [T0 + MIN, 2, 3, 1, 2.5]]));
    expect(s.length).toBe(2);
    expect(s.bar(0)).toEqual({ t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 });
    expect(() => parseCsv("time,o,h,l,c,v\n")).toThrow(/header/);
    expect(() => parseCsv(csv([[T0 + MIN, 1, 1, 1, 1], [T0, 1, 1, 1, 1]]))).toThrow(/oldest first/);
    expect(() => parseCsv("datetime,open,high,low,close,volume\n2024-03-05 15:00:00+00:00,1,x,1,1,1\n")).toThrow(/bad number/);
    expect(() => parseCsv("datetime,open,high,low,close,volume\n2024-03-05 15:00:00+00:00,1\n")).toThrow(/6 columns/);
  });

  it("counts only closed bars: t + 1 minute <= now", () => {
    const s = parseCsv(csv(flat(T0, 5, 100)));
    expect(s.closedCount(T0)).toBe(0);
    expect(s.closedCount(T0 + MIN - 1)).toBe(0);
    expect(s.closedCount(T0 + MIN)).toBe(1);
    expect(s.closedCount(T0 + 10 * MIN)).toBe(5);
  });
});

describe("BarStore", () => {
  it("loads a root's file once, reports its range from head and tail, and knows missing roots", () => {
    const dir = tmp();
    writeData(dir, { NQ: flat(T0, 3, 100) });
    const store = new BarStore(dir);
    expect(store.has("NQ")).toBe(true);
    expect(store.has("ES")).toBe(false);
    expect(store.range("NQ")).toEqual({ first: iso(T0), last: iso(T0 + 2 * MIN) });
    expect(store.range("ES")).toBeNull();
    expect(store.get("NQ")).toBe(store.get("NQ"));
    expect(store.range("NQ")).toEqual({ first: iso(T0), last: iso(T0 + 2 * MIN) });
    expect(() => store.get("ES")).toThrow(join(dir, "ES_1min.csv"));
  });
});

describe("aggregate", () => {
  const s = parseCsv(
    csv(seq(T0, [[10, 11, 9, 10.5], [10.5, 12, 10, 11], [11, 11.5, 8, 9], [9, 10, 9, 9.5], [9.5, 13, 9, 12], [12, 12, 11, 11.5], [11.5, 14, 11, 13]])),
  );
  const run = (o: Partial<Parameters<typeof aggregate>[1]>) =>
    aggregate(s, { unit: "minute", unitNumber: 5, limit: 100, from: null, to: Infinity, cutoff: T0 + 7 * MIN, partial: false, ...o });

  it("builds N-minute bars from closed 1-minute bars, oldest first", () => {
    expect(run({})).toEqual([{ t: iso(T0), o: 10, h: 13, l: 8, c: 12, v: 50 }]);
    expect(run({ partial: true })).toEqual([
      { t: iso(T0), o: 10, h: 13, l: 8, c: 12, v: 50 },
      { t: iso(T0 + 5 * MIN), o: 12, h: 14, l: 11, c: 13, v: 20 },
    ]);
  });

  it("never uses a bar that has not closed", () => {
    expect(run({ unitNumber: 1, cutoff: T0 + 2 * MIN + 30000 }).map((b) => b.c)).toEqual([10.5, 11]);
    expect(run({ unitNumber: 5, cutoff: T0 + 4 * MIN, partial: true })).toEqual([{ t: iso(T0), o: 10, h: 12, l: 8, c: 9.5, v: 40 }]);
  });

  it("honours limit, from and to", () => {
    expect(run({ unitNumber: 1, limit: 2 }).map((b) => b.t)).toEqual([iso(T0 + 5 * MIN), iso(T0 + 6 * MIN)]);
    expect(run({ unitNumber: 1, from: T0 + 5 * MIN }).map((b) => b.c)).toEqual([11.5, 13]);
    expect(run({ unitNumber: 1, to: T0 + 2 * MIN }).map((b) => b.c)).toEqual([10.5, 11]);
    expect(run({ unitNumber: 2, from: T0 + 1 * MIN })).toHaveLength(2); // T0's bucket begins before `from`; 15:06's is still forming
  });

  it("aligns hours to UTC and days and weeks to the 17:00 CT trading day", () => {
    expect(bucketOf("hour", 1)(T0 + 30 * MIN)).toEqual({ start: T0, end: T0 + 60 * MIN });
    // 2024-03-05 is CST: the trading day runs 23:00Z to 23:00Z.
    expect(bucketOf("day", 1)(T0)).toEqual({ start: Date.parse("2024-03-04T23:00:00Z"), end: Date.parse("2024-03-05T23:00:00Z") });
    expect(bucketOf("day", 2)(T0).end).toBe(Date.parse("2024-03-06T23:00:00Z"));
    // The week opens Sunday 2024-03-03 17:00 CST and closes Friday 2024-03-08 17:00 CST.
    expect(bucketOf("week", 1)(T0)).toEqual({ start: Date.parse("2024-03-03T23:00:00Z"), end: Date.parse("2024-03-08T23:00:00Z") });
  });

  it("closes a daily bar at the trading day's end", () => {
    const d = parseCsv(csv([...flat(Date.parse("2024-03-05T22:58:00Z"), 4, 100)]));
    const day = (cutoff: number) => aggregate(d, { unit: "day", unitNumber: 1, limit: 10, from: null, to: Infinity, cutoff, partial: false });
    expect(day(Date.parse("2024-03-05T23:00:00Z"))).toEqual([{ t: "2024-03-04T23:00:00.000Z", o: 100, h: 100, l: 100, c: 100, v: 20 }]);
    expect(day(Date.parse("2024-03-05T22:59:30Z"))).toEqual([]);
  });
});
