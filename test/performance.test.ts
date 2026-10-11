import { describe, expect, it } from "vitest";
import { summarizeRoundTrips, summarizeTrades, type Trade } from "../src/performance.js";

const t = (pnl: number | null, extra: Partial<Trade> = {}): Trade => ({
  id: 1, contractId: "BT.MNQ", creationTimestamp: "", price: 1, profitAndLoss: pnl, fees: 1, side: 0, size: 1,
  voided: false, orderId: 1, ...extra,
});

describe("summarizeTrades", () => {
  it("computes win rate, net, and profit factor from closing fills", () => {
    const s = summarizeTrades([t(null), t(100), t(null), t(-50), t(null), t(0), t(999, { voided: true })]).overall;
    expect(s).toMatchObject({ closingFills: 3, wins: 1, losses: 1, scratches: 1, winRate: 0.33, grossPnL: 50, fees: 6, netPnL: 44, profitFactor: 2 });
  });
  it("handles no trades", () => {
    expect(summarizeTrades([]).overall).toMatchObject({ closingFills: 0, winRate: null, netPnL: 0 });
  });
});

describe("summarizeRoundTrips", () => {
  const trip = (k: number, net: number, rNet: number | null, maeR: number | null, mfeR: number | null, barsHeld: number, contractId = "BT.MNQ") => ({
    contractId, exitTime: new Date(Date.UTC(2024, 2, 5, 15, k)).toISOString(), exitFillId: k, net, rNet, maeR, mfeR, barsHeld, gross: net + 1, fees: 1,
  });
  it("grades round trips in exit order: $ and R, drawdown, MAE/MFE of winners vs losers", () => {
    // Exit order: +10, -5, -8, +20 -> equity 10, 5, -3, 17: max drawdown 13.
    const trips = [trip(4, 20, 2, -0.3, 2.5, 6, "BT.ES"), trip(1, 10, 1, -1.2, 1.5, 3), trip(3, -8, null, null, null, 2), trip(2, -5, -0.5, -0.5, 0.2, 1)];
    const s = summarizeRoundTrips(trips);
    expect(s.overall).toEqual({
      trades: 4, wins: 2, losses: 2, scratches: 0, winRate: 0.5, grossPnL: 21, fees: 4, netPnL: 17,
      avgWin: 15, avgLoss: -6.5, expectancy: 4.25, profitFactor: 2.31, maxDrawdown: 13,
      tradesWithR: 3, avgWinR: 1.5, avgLossR: -0.5, expectancyR: 0.833,
      avgMaeRWinners: -0.75, avgMfeRWinners: 2, avgMaeRLosers: -0.5, avgMfeRLosers: 0.2, winnersPastMinus1R: 0.5, avgBarsHeld: 3,
    });
    expect(s.byContract["BT.ES"]).toMatchObject({ trades: 1, maxDrawdown: 0, winnersPastMinus1R: 0 });
    expect(s.byContract["BT.MNQ"]).toMatchObject({ trades: 3, maxDrawdown: 13, netPnL: -3 });
  });
  it("handles no round trips", () => {
    expect(summarizeRoundTrips([]).overall).toMatchObject({ trades: 0, winRate: null, expectancy: null, expectancyR: null, profitFactor: null, maxDrawdown: 0, winnersPastMinus1R: null });
  });
});
