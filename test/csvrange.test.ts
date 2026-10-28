import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BarStore, parseCsv } from "../src/bars.js";
import { readCsvRange } from "../src/csvrange.js";
import { tmp } from "./helpers.js";

const MIN = 60000;
const T0 = Date.UTC(2024, 0, 1);
const ts = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(".000Z", "+00:00");

/** A long time-sorted CSV (well past the search window), with a gap, duplicate timestamps and float noise. */
function longCsv(eol: string): { text: string; times: number[] } {
  const rows = ["datetime,open,high,low,close,volume"];
  const times: number[] = [];
  let t = T0;
  for (let i = 0; i < 30000; i++) {
    t += i === 12000 ? 3 * 24 * 60 * MIN : MIN;
    times.push(t);
    rows.push(`${ts(t)},${100 + i * 0.25 + 1e-12},${101 + i * 0.25},${99 + i * 0.25},${100.5 + i * 0.25},${i}`);
    if (i % 5000 === 7) rows.push(`${ts(t)},9,9,9,9,9`); // a duplicate timestamp: the first row stays
  }
  return { text: rows.join(eol) + eol, times };
}

describe("readCsvRange", () => {
  for (const eol of ["\n", "\r\n"]) {
    it(`reads the same rows as the full parse over any range (eol ${JSON.stringify(eol)})`, () => {
      const { text, times } = longCsv(eol);
      const dir = tmp();
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "X_1min.csv");
      writeFileSync(file, text);
      const full = parseCsv(text);
      const probes = [T0 - MIN, times[0], times[0] + 1, times[1], times[11999], times[12000] - 1, times[12000], times[12000] - MIN, times[20000] + 5, times.at(-1)!, times.at(-1)! + MIN, times.at(-1)! + 1e9];
      for (let i = 0; i < 40; i++) probes.push(times[(i * 7919) % times.length]);
      for (const from of probes) {
        for (const to of [from, from + MIN, from + 90 * MIN, from + 3000 * MIN, from - MIN]) {
          const a = full.lowerBound(from);
          const b = Math.max(a, full.lowerBound(to));
          const got = readCsvRange(file, from, to);
          expect([...got.t], `${from}..${to}`).toEqual([...full.t.slice(a, b)]);
          expect([...got.o]).toEqual([...full.o.slice(a, b)]);
          expect([...got.c]).toEqual([...full.c.slice(a, b)]);
          expect([...got.v]).toEqual([...full.v.slice(a, b)]);
        }
      }
    });
  }

  it("BarStore.slice reads the file without caching it, and slices the cached series once loaded", () => {
    const { text, times } = longCsv("\n");
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "X_1min.csv"), text);
    const store = new BarStore(dir);
    const from = times[100];
    const to = times[160];
    const cold = store.slice("X", from, to)!;
    expect(cold.length).toBe(60);
    expect(store.slice("Y", from, to)).toBeNull();
    const full = store.get("X");
    const warm = store.slice("X", from, to)!;
    expect([...warm.t]).toEqual([...cold.t]);
    expect([...warm.c]).toEqual([...cold.c]);
    expect(store.stamp("X")).toMatch(/^\d+:\d+$/);
    expect(store.stamp("Y")).toBeNull();
    expect(full.length).toBe(30000);
  });
});
