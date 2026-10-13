import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DerivedStore, dayPath, listDays, manifestPath, readDay, readManifest, rowAt } from "../src/store.js";
import { tmp } from "./helpers.js";
import { MIN, Z, builtStore } from "./storefixture.js";

const us = (s: string) => Z(s) * 1000;

describe("derived store reader", () => {
  it("covers the ET days of built months inside the roll table, and gives the table's front contract there", async () => {
    const { dataDir } = await builtStore();
    const s = new DerivedStore(dataDir);
    expect(s.covers("NQ", Z("2024-03-01T05:00:00Z"))).toBe(true); // 00:00 ET March 1
    expect(s.covers("NQ", Z("2024-03-01T04:59:59Z"))).toBe(false); // still February in ET
    expect(s.covers("NQ", Z("2024-04-01T03:59:59Z"))).toBe(true); // March 31 ET
    expect(s.covers("NQ", Z("2024-04-01T04:00:00Z"))).toBe(false);
    expect(s.covers("ES", Z("2024-03-05T15:00:00Z"))).toBe(false);
    // The front changes at the trading day's start (Sunday 18:00 ET) before the data's Monday 00:00 ET switch.
    expect(s.frontAt("NQ", Z("2024-03-10T21:59:59Z"))).toBe("H24");
    expect(s.frontAt("NQ", Z("2024-03-10T22:00:00Z"))).toBe("M24");
    expect(s.switchesBetween("NQ", Z("2024-03-10T00:00:00Z"), Z("2024-03-12T00:00:00Z"))).toEqual([{ at: Z("2024-03-11T04:00:00Z"), off: "H24" }]);
    expect(s.manifestHash("NQ")).toMatch(/^[0-9a-f]{64}$/);
    expect(s.frontAt("NQ", Z("2024-05-01T00:00:00Z"))).toBeNull();
    expect(s.has("NQ", "M24")).toBe(true);
    expect(s.has("NQ", "U24")).toBe(false);
    expect(s.manifest("NQ")).toBe(s.manifest("NQ"));
  });

  it("serves a contract's own raw bars, oldest first, cached", async () => {
    const { dataDir } = await builtStore();
    const s = new DerivedStore(dataDir);
    const h = s.bars("NQ", "H24");
    expect([...h.t]).toEqual([
      Z("2024-03-07T14:30:00Z"),
      Z("2024-03-07T14:31:00Z"),
      Z("2024-03-08T14:30:00Z"),
      Z("2024-03-08T14:31:00Z"),
      Z("2024-03-10T22:00:00Z"),
      Z("2024-03-10T22:01:00Z"),
    ]);
    expect(h.bar(0)).toEqual({ t: Z("2024-03-07T14:30:00Z"), o: 18000, h: 18001.5, l: 17999.25, c: 17999.25, v: 3 });
    const m = s.bars("NQ", "M24");
    expect([...m.c]).toEqual([18270, 18270.5, 18271, 18280, 18280]);
    expect(s.bars("NQ", "M24")).toBe(m);
    expect(() => s.bars("NQ", "U24")).toThrow(/no stored bars for NQ U24/);
    // A day file gone after the manifest was written: rebuild.
    rmSync(dayPath(dataDir, "NQ", "2024-03-07"));
    expect(() => new DerivedStore(dataDir).bars("NQ", "H24")).toThrow(/2024-03-07 .* missing/);
  });

  it("reads a day's normalized events from the source, sliced by time, with the quote state replayed", async () => {
    const { dataDir } = await builtStore();
    const s = new DerivedStore(dataDir);
    const all = await s.events("NQ", "2024-03-07");
    // The 22:30Z rows are in the daily break: left out.
    expect(all.trades).toEqual([
      { t: us("2024-03-07T14:30:01Z"), price: 18000, size: 1 },
      { t: us("2024-03-07T14:30:02Z"), price: 18001.5, size: 1 },
      { t: us("2024-03-07T14:30:03Z"), price: 17999.25, size: 1 },
      { t: us("2024-03-07T14:31:01Z"), price: 18002, size: 1 },
    ]);
    expect(all.quotes[0]).toEqual({ t: us("2024-03-07T14:30:00Z"), bid: 17999.75, bidSize: 5, ask: null, askSize: null });
    expect(all.quotes).toHaveLength(4);
    expect(all.depth.map((d) => [d.t, d.act, d.size])).toEqual([
      [us("2024-03-07T14:30:00Z"), "add", 7],
      [us("2024-03-07T14:30:00Z") + 2000, "remove", 0],
      [us("2024-03-07T14:32:00Z"), "add", 7],
      [us("2024-03-07T14:32:00Z") + 2000, "remove", 0],
    ]);
    const slice = await s.events("NQ", "2024-03-07", { from: Z("2024-03-07T14:31:00Z"), to: Z("2024-03-07T14:32:00Z") });
    expect(slice.trades.map((x) => x.price)).toEqual([18002]);
    // The quote state at 14:31: the new bid, and the ask set in the minute before (replayed from the day start).
    expect(slice.quotes[0]).toEqual({ t: us("2024-03-07T14:31:00Z"), bid: 18001.75, bidSize: 5, ask: 18000, askSize: 4 });
    expect(slice.depth).toEqual([]);
    const noL2 = await s.events("NQ", "2024-03-07", { l2: false });
    expect(noL2.depth).toEqual([]);
    expect((await s.events("NQ", "2024-03-14")).trades).toEqual([]); // L2 only
    await expect(s.events("NQ", "2024-03-13")).rejects.toThrow(/no stored day 2024-03-13/);
  });

  it("reads events from BACKTESTER_ORDERBOOK_DIR when the source moved", async () => {
    const { dataDir, source, dir } = await builtStore();
    const moved = join(dir, "moved");
    cpSync(source, moved, { recursive: true });
    rmSync(source, { recursive: true });
    await expect(new DerivedStore(dataDir).events("NQ", "2024-03-11")).rejects.toThrow();
    expect((await new DerivedStore(dataDir, moved).events("NQ", "2024-03-11")).trades).toHaveLength(3);
  });

  it("ignores files of another format and lists day files only", async () => {
    const { dataDir } = await builtStore();
    writeFileSync(dayPath(dataDir, "NQ", "2024-03-07"), gzipSync(JSON.stringify({ format: 99 })));
    expect(readDay(dataDir, "NQ", "2024-03-07")).toBeNull();
    writeFileSync(join(dataDir, "derived", "NQ", "days", "notes.txt"), "x");
    expect(listDays(dataDir, "NQ")).toContain("2024-03-07");
    expect(listDays(dataDir, "NQ")).not.toContain("notes.txt");
    expect(listDays(tmp(), "NQ")).toEqual([]);
    writeFileSync(manifestPath(dataDir, "NQ"), JSON.stringify({ format: 99 }));
    expect(readManifest(dataDir, "NQ")).toBeNull();
    expect(new DerivedStore(dataDir).covers("NQ", Z("2024-03-05T15:00:00Z"))).toBe(false);
  });

  it("finds the first row of a minute in the index", () => {
    const index: Array<[number, number]> = [
      [0, 0],
      [MIN, 4],
      [3 * MIN, 9],
    ];
    expect(rowAt(index, 0, 12)).toBe(0);
    expect(rowAt(index, 2 * MIN, 12)).toBe(9);
    expect(rowAt(index, 4 * MIN, 12)).toBe(12);
  });

  it("doesn't use a store built with another roll table, and has no store outside the table", async () => {
    const { dataDir } = await builtStore();
    const p = manifestPath(dataDir, "NQ");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.rollTable.hash = "0".repeat(64);
    writeFileSync(p, JSON.stringify(m));
    const s = new DerivedStore(dataDir);
    expect(s.manifest("NQ")).toBeNull();
    expect(s.manifestHash("NQ")).toBeNull();
    expect(s.switchesBetween("NQ", 0, Date.now())).toEqual([]);
    const early = await builtStore({ "2021-03-05": { l1: [[Z("2021-03-05T15:00:00Z"), 2, 13000, 1]] } }, ["202103", "202103"]);
    expect(new DerivedStore(early.dataDir).covers("NQ", Z("2021-03-05T15:00:00Z"))).toBe(false);
  });
});
