import type { Config } from "./config.js";

export class RiskError extends Error {}

/** "BT.MNQ" -> "MNQ" (this server's contract ids). Falls back to the whole id if the shape is unexpected. */
export function symbolRoot(contractId: string): string {
  const parts = contractId.split(".");
  return (parts.length === 2 && parts[0] === "BT" ? parts[1] : contractId).toUpperCase();
}

const CHICAGO = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
});

const offsetAt = (t: number) => {
  const local = new Date(new Date(t).toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const utc = new Date(new Date(t).toLocaleString("en-US", { timeZone: "UTC" }));
  return local.getTime() - utc.getTime();
};

const dayStartCache = new Map<number, number>();

/**
 * Start of the CME trading day containing `now`: the most recent 17:00
 * America/Chicago (18:00 ET). Daily P&L and the daily loss limit reset on it.
 * Same math as projectx-mcp's risk.ts; cached per hour (the boundary is on the hour).
 */
export function tradingDayStart(now: Date = new Date()): Date {
  const hour = Math.floor(now.getTime() / 36e5);
  const hit = dayStartCache.get(hour);
  if (hit !== undefined) return new Date(hit);
  const parts = Object.fromEntries(CHICAGO.formatToParts(now).map((p) => [p.type, p.value]));
  const y = Number(parts.year), m = Number(parts.month) - 1, d = Number(parts.day), h = Number(parts.hour);
  const dayOffset = h >= 17 ? 0 : -1;
  // 17:00 Chicago on that calendar date, expressed as if it were UTC, then shifted by Chicago's offset.
  const naive = Date.UTC(y, m, d + dayOffset, 17);
  let result = naive - offsetAt(naive);
  result = naive - offsetAt(result);
  if (dayStartCache.size > 100000) dayStartCache.clear();
  dayStartCache.set(hour, result);
  return new Date(result);
}

export interface TradeLike {
  profitAndLoss: number | null;
  fees: number | null;
  voided: boolean;
}

/** Realized P&L net of fees, ignoring voided trades. */
export function realizedNet(trades: TradeLike[]): number {
  return trades.filter((t) => !t.voided).reduce((sum, t) => sum + (t.profitAndLoss ?? 0) - (t.fees ?? 0), 0);
}

export function assertTradingAllowed(config: Config, accountId: number): void {
  if (!config.tradingEnabled) {
    throw new RiskError(
      "Trading is disabled on this MCP server (BACKTESTER_TRADING_ENABLED is not true). Read-only tools still work.",
    );
  }
  if (config.allowedAccountIds.length && !config.allowedAccountIds.includes(accountId)) {
    throw new RiskError(`Account ${accountId} is not in BACKTESTER_ALLOWED_ACCOUNT_IDS (${config.allowedAccountIds.join(", ")}).`);
  }
}

/** The replay window: orders only while the clock lies in [BACKTESTER_START, BACKTESTER_END]. */
export function assertInWindow(config: Config, now: Date): void {
  const t = now.getTime();
  if (config.start !== null && t < config.start) {
    throw new RiskError(
      `The replay clock (${now.toISOString()}) is before BACKTESTER_START (${new Date(config.start).toISOString()}): the run has not started. Bars before it are lookback history only.`,
    );
  }
  if (config.end !== null && t > config.end) {
    throw new RiskError(
      `The replay clock (${now.toISOString()}) is after BACKTESTER_END (${new Date(config.end).toISOString()}): the run is over.`,
    );
  }
}

export function assertSymbolAllowed(config: Config, contractId: string): void {
  const root = symbolRoot(contractId);
  if (config.allowedSymbols.length && !config.allowedSymbols.includes(root)) {
    throw new RiskError(`Symbol ${root} is not in BACKTESTER_ALLOWED_SYMBOLS (${config.allowedSymbols.join(", ")}).`);
  }
}

export function assertOrderSize(config: Config, size: number): void {
  if (size > config.maxOrderSize) {
    throw new RiskError(`Order size ${size} exceeds BACKTESTER_MAX_ORDER_SIZE (${config.maxOrderSize}).`);
  }
}

export interface ExposureInput {
  /** Current net position: +long / -short. */
  currentNet: number;
  /** Sum of same-side resting entry orders (limit/join, and market orders waiting for the next bar) on this contract. */
  pendingSameSide: number;
  side: "buy" | "sell";
  size: number;
}

/** Worst-case net position if this order and resting same-side entries all fill. */
export function projectedNet({ currentNet, pendingSameSide, side, size }: ExposureInput): number {
  const sign = side === "buy" ? 1 : -1;
  return currentNet + sign * (pendingSameSide + size);
}

/** True when the order moves the position further from flat. */
export function increasesExposure(input: ExposureInput): boolean {
  return Math.abs(projectedNet(input)) > Math.abs(input.currentNet);
}

/**
 * True when the order opens new exposure: the worst case ends further from flat, or the order
 * itself goes through flat (the part beyond flattening is a new position on the other side,
 * even when it ends no larger). Pure reduction never does.
 */
export function opensExposure(input: ExposureInput): boolean {
  const sign = input.side === "buy" ? 1 : -1;
  const reverses = input.currentNet * sign < 0 && input.size > Math.abs(input.currentNet);
  return increasesExposure(input) || reverses;
}

export function assertPositionLimit(config: Config, input: ExposureInput): void {
  const projected = projectedNet(input);
  if (opensExposure(input) && Math.abs(projected) > config.maxPositionSize) {
    throw new RiskError(
      `Order would take net position to ${projected} (current ${input.currentNet}, resting same-side entries ${input.pendingSameSide}); ` +
        `BACKTESTER_MAX_POSITION_SIZE is ${config.maxPositionSize}.`,
    );
  }
}

export function assertDailyLoss(config: Config, realized: number): void {
  if (config.maxDailyLoss > 0 && realized <= -config.maxDailyLoss) {
    throw new RiskError(
      `Daily loss limit reached: realized net P&L today is ${realized.toFixed(2)} (limit -${config.maxDailyLoss}). ` +
        "Only risk-reducing orders are allowed until the next trading day (17:00 America/Chicago).",
    );
  }
}
