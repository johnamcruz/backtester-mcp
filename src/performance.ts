export interface Trade {
  id: number;
  contractId: string;
  creationTimestamp: string;
  price: number;
  profitAndLoss: number | null;
  fees: number | null;
  side: number;
  size: number;
  voided: boolean;
  orderId: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

function stats(trades: Trade[]) {
  const live = trades.filter((t) => !t.voided);
  // A null profitAndLoss marks the opening half of a round turn.
  const closes = live.filter((t) => t.profitAndLoss !== null);
  const pnls = closes.map((t) => t.profitAndLoss as number);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const gross = pnls.reduce((a, b) => a + b, 0);
  const fees = live.reduce((a, t) => a + (t.fees ?? 0), 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  return {
    fills: live.length,
    closingFills: closes.length,
    wins: wins.length,
    losses: losses.length,
    scratches: pnls.length - wins.length - losses.length,
    winRate: closes.length ? round(wins.length / closes.length) : null,
    grossPnL: round(gross),
    fees: round(fees),
    netPnL: round(gross - fees),
    avgWin: wins.length ? round(grossWin / wins.length) : null,
    avgLoss: losses.length ? round(-grossLoss / losses.length) : null,
    largestWin: wins.length ? round(Math.max(...wins)) : null,
    largestLoss: losses.length ? round(Math.min(...losses)) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    expectancyPerClose: closes.length ? round((gross - fees) / closes.length) : null,
  };
}

/** Aggregate performance statistics from Trade/search results. */
export function summarizeTrades(trades: Trade[]) {
  const byContract: Record<string, ReturnType<typeof stats>> = {};
  for (const id of new Set(trades.map((t) => t.contractId))) {
    byContract[id] = stats(trades.filter((t) => t.contractId === id));
  }
  return { overall: stats(trades), byContract };
}

/** The fields of a round trip (metrics.ts) that the aggregate reads. */
export interface TripLike {
  contractId: string;
  exitTime: string | null;
  exitFillId: number | null;
  net: number;
  rNet: number | null;
  maeR: number | null;
  mfeR: number | null;
  barsHeld: number;
  gross: number;
  fees: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const roundOr = (x: number | null, k = 100) => (x === null ? null : Math.round(x * k) / k + 0);

function tripStats(trips: TripLike[]) {
  // A round trip wins or loses on its net P&L (after fees), as the harness backtester counts it.
  const wins = trips.filter((t) => t.net > 0);
  const losses = trips.filter((t) => t.net < 0);
  const withR = trips.filter((t) => t.rNet !== null);
  const winsR = withR.filter((t) => t.net > 0);
  const lossesR = withR.filter((t) => t.net < 0);
  const sum = (xs: TripLike[]) => xs.reduce((a, t) => a + t.net, 0);
  const grossWin = sum(wins);
  const grossLoss = -sum(losses);
  // Max drawdown of the realized equity curve: cumulative net per round trip, in exit order, from 0.
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of trips) {
    equity += t.net;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const R = (xs: TripLike[], k: "rNet" | "maeR" | "mfeR") => roundOr(mean(xs.map((t) => t[k] as number)), 1000);
  return {
    trades: trips.length,
    wins: wins.length,
    losses: losses.length,
    scratches: trips.length - wins.length - losses.length,
    winRate: trips.length ? roundOr(wins.length / trips.length) : null,
    grossPnL: roundOr(trips.reduce((a, t) => a + t.gross, 0)),
    fees: roundOr(trips.reduce((a, t) => a + t.fees, 0)),
    netPnL: roundOr(sum(trips)),
    avgWin: roundOr(mean(wins.map((t) => t.net))),
    avgLoss: roundOr(mean(losses.map((t) => t.net))),
    expectancy: roundOr(mean(trips.map((t) => t.net))),
    profitFactor: grossLoss > 0 ? roundOr(grossWin / grossLoss) : null,
    maxDrawdown: roundOr(maxDrawdown),
    tradesWithR: withR.length,
    avgWinR: R(winsR, "rNet"),
    avgLossR: R(lossesR, "rNet"),
    expectancyR: R(withR, "rNet"),
    avgMaeRWinners: R(winsR, "maeR"),
    avgMfeRWinners: R(winsR, "mfeR"),
    avgMaeRLosers: R(lossesR, "maeR"),
    avgMfeRLosers: R(lossesR, "mfeR"),
    winnersPastMinus1R: winsR.length ? roundOr(winsR.filter((t) => (t.maeR as number) <= -1).length / winsR.length) : null,
    avgBarsHeld: roundOr(mean(trips.map((t) => t.barsHeld))),
  };
}

/** Aggregate statistics of closed round trips (metrics.ts), overall and per contract, in exit order. */
export function summarizeRoundTrips(trips: TripLike[]) {
  const ordered = [...trips].sort((a, b) => Date.parse(a.exitTime ?? "") - Date.parse(b.exitTime ?? "") || (a.exitFillId ?? 0) - (b.exitFillId ?? 0));
  const byContract: Record<string, ReturnType<typeof tripStats>> = {};
  for (const id of new Set(ordered.map((t) => t.contractId))) byContract[id] = tripStats(ordered.filter((t) => t.contractId === id));
  return { overall: tripStats(ordered), byContract };
}
