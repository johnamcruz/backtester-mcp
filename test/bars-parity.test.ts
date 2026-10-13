import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flat, setup, writeData } from "./helpers.js";
import { Z, builtStore } from "./storefixture.js";

/**
 * get_bars' result shape against projectx-mcp (live, the reference), when PROJECTX_MCP_DIR points at a
 * projectx-mcp checkout (skipped without it, like the vectors' byte check): the same top-level keys, the
 * same `orderFlow` keys, and the same keys in each bar's `flow` and windows, for the same parameters, with
 * flow and without (a day bar). Live's result comes from its own `barsWithFlow` (src/flowtools.ts) over a
 * feed with no minutes, and its base keys from its get_bars handler (src/server.ts).
 */
const DIR = process.env.PROJECTX_MCP_DIR;
const keys = (o: object) => Object.keys(o).sort();

async function live(unit: string, bars: Array<{ t: string }>, windows: number[]) {
  const mod = await import(join(DIR as string, "src", "flowtools.ts"));
  const feed = { ensure: async () => {}, records: () => [], coverage: () => ({}) };
  const deps = { config: { flowLargePrint: 10 }, flow: feed, now: () => Date.parse(bars.at(-1)?.t ?? "2024-03-07T15:00:00Z"), warn: () => {} };
  return (await mod.barsWithFlow(deps, "CON.F.US.MNQ.H24", bars, unit, 1, windows)) as { bars: Array<Record<string, any>>; orderFlow: object };
}

function liveBaseKeys(): string[] {
  const src = readFileSync(join(DIR as string, "src", "server.ts"), "utf8");
  const m = /const base = \{(.*?)\};/.exec(src);
  if (!m) throw new Error("projectx-mcp get_bars: no `const base = {...}` found; update this test");
  return m[1].split(",").map((p) => p.split(":")[0].trim()).filter(Boolean);
}

describe.skipIf(!DIR)("get_bars shape against projectx-mcp", () => {
  it("has live's keys exactly: top level, orderFlow, each bar's flow and windows (minute bars with flow, day bars without)", async () => {
    const b = await builtStore();
    writeData(b.dataDir, { NQ: flat(Z("2024-03-05T14:00:00Z"), 60, 20000) });
    const { call } = await setup({ dir: b.dir, now: Z("2024-03-07T14:35:00Z") });
    for (const unit of ["minute", "day"]) {
      const mine = (await call("get_bars", { contractId: "BT.MNQ.H24", unit, unitNumber: 1, limit: 10, includePartialBar: true, includeOrderFlow: true, flowWindows: [2] })).data;
      const ref = await live(unit, mine.bars.map(({ flow: _f, ...bar }: any) => bar), [2]);
      expect(keys(mine), unit).toEqual([...liveBaseKeys(), ...keys(ref)].sort());
      expect(keys(mine.orderFlow), unit).toEqual(keys(ref.orderFlow));
      expect(mine.bars.length).toBeGreaterThan(0);
      for (let i = 0; i < mine.bars.length; i++) {
        expect(keys(mine.bars[i]), unit).toEqual(keys(ref.bars[i]));
        expect(keys(mine.bars[i].flow), unit).toEqual(keys(ref.bars[i].flow));
        expect(keys(mine.bars[i].flow.windows["2"]), unit).toEqual(keys(ref.bars[i].flow.windows["2"]));
      }
    }
  });
});
