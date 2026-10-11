/**
 * Optional dev check: trade metrics against the harness backtester's simulated broker
 * (futures-trading-harness scripts/lib/backtest/sim-broker.js, as engine.js#closeTrade rounds
 * them) on the same bars. Runs only with FTH_HARNESS_DIR set to a harness checkout:
 *   FTH_HARNESS_DIR=/path/to/futures-trading-harness npx vitest run test/harness-parity.test.ts
 * The self-contained unit tests are in metrics.test.ts.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN, T0, flat, iso, seq, setup } from "./helpers.js";

const dir = process.env.FTH_HARNESS_DIR ?? "";
const simBroker = dir ? join(dir, "scripts/lib/backtest/sim-broker.js") : "";
const available = !!dir && existsSync(simBroker);

type OHLC = [number, number, number, number];

/** The harness: a market entry on the bar before `bars[0]` (fill: next-open), stop and target in ticks, settled bar by bar. */
function harness(bars: OHLC[], sign: 1 | -1, stopTicks: number, targetTicks: number) {
  const { createSimBroker } = createRequire(import.meta.url)(simBroker);
  const b = createSimBroker({ tickSize: 0.25, slippageTicks: 1 });
  const plan = { trailActivateR: null, trailGivebackR: null, maxBars: 0 };
  b.submitMarket({ sign, risk: stopTicks * 0.25, size: 1, tickValue: 0.5, fee: 0.37, plan, target: { ticks: targetTicks } }, { price: bars[0][0] - sign * 0.25 });
  for (const [o, h, l, c] of bars) {
    const bar = { o, h, l, c };
    if (b.position?.pending) b.fillAtOpen(bar);
    const exit = b.onBar(bar) ?? b.manage(bar);
    if (exit) {
      const p = exit.position;
      const r3 = (x: number) => Math.round(x * 1000) / 1000;
      return { r: r3((p.sign * (exit.price - p.entry)) / p.risk), mfeR: r3(p.peakR), maeR: r3(p.troughR), barsHeld: p.barsHeld, reason: exit.reason, exit: exit.price };
    }
  }
  throw new Error("no exit");
}

/** This server: the same entry through place_order with brackets, then the round trip on the closing fill. */
async function server(bars: OHLC[], sign: 1 | -1, stopTicks: number, targetTicks: number) {
  const { exchange, setNow } = await setup({ data: { NQ: [...flat(T0 - 5 * MIN, 5, bars[0][0]), ...seq(T0, bars)] } });
  exchange.place({
    accountId: 1, contractId: "BT.MNQ", type: 2, side: sign > 0 ? 0 : 1, size: 1, limitPrice: null, stopPrice: null, trailPrice: null, customTag: null,
    stopLossBracket: { ticks: stopTicks, type: 4 }, takeProfitBracket: { ticks: targetTicks, type: 1 },
  });
  setNow(T0 + bars.length * MIN);
  const [trip] = exchange.tradeReport(1, iso(T0)).roundTrips;
  return { r: trip.r, mfeR: trip.mfeR, maeR: trip.maeR, barsHeld: trip.barsHeld, reason: trip.reason, exit: trip.exitPrice };
}

describe.skipIf(!available)("parity with the harness sim-broker (FTH_HARNESS_DIR)", () => {
  it("a stop exit: r, MAE, MFE, bars held and reason match", async () => {
    const bars: OHLC[] = [[20000, 20002, 19999, 20001], [20001, 20004, 19998, 20003], [20003, 20003.5, 19990, 19992]];
    expect(await server(bars, 1, 20, 40)).toEqual(harness(bars, 1, 20, 40));
  });

  it("a short target exit whose bar opens at its high and reaches only the target: everything matches", async () => {
    // Short at 20000 - 1 tick = 19999.75, target 16 ticks = 19995.75, reached exactly by bar 2's low.
    const bars: OHLC[] = [[20000, 20001, 19998, 19999], [19999, 19999, 19996, 19997], [19997, 19997, 19995.75, 19996]];
    expect(await server(bars, -1, 20, 16)).toEqual(harness(bars, -1, 20, 16));
  });

  it("documented difference: the exit bar's own range counts in the harness's MFE, not here", async () => {
    // Bar 1 runs to 20010 and then (or before) through the stop: the harness counts its high, this server does not.
    const bars: OHLC[] = [[20000, 20002, 19999, 20001], [20001, 20010, 19990, 19992]];
    const ours = await server(bars, 1, 20, 80);
    const theirs = harness(bars, 1, 20, 80);
    expect({ ...ours, mfeR: 0 }).toEqual({ ...theirs, mfeR: 0 });
    expect(ours.mfeR).toBeLessThan(theirs.mfeR);
  });
});
