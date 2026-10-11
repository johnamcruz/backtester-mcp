import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  RiskError,
  assertDailyLoss,
  assertInWindow,
  assertOrderSize,
  assertPositionLimit,
  assertSymbolAllowed,
  assertTradingAllowed,
  increasesExposure,
  opensExposure,
  realizedNet,
  symbolRoot,
  tradingDayStart,
} from "../src/risk.js";

const cfg = (extra: Record<string, string> = {}) =>
  loadConfig({ BACKTESTER_DATA_DIR: "/d", BACKTESTER_NOW: "2024-03-05T15:00:00Z", BACKTESTER_TRADING_ENABLED: "true", ...extra });

describe("guardrails", () => {
  it("blocks when trading disabled or account not allowed", () => {
    expect(() => assertTradingAllowed(cfg({ BACKTESTER_TRADING_ENABLED: "false" }), 1)).toThrow(RiskError);
    expect(() => assertTradingAllowed(cfg({ BACKTESTER_ALLOWED_ACCOUNT_IDS: "5, 6" }), 1)).toThrow(/not in/);
    expect(() => assertTradingAllowed(cfg({ BACKTESTER_ALLOWED_ACCOUNT_IDS: "5, 6" }), 6)).not.toThrow();
  });

  it("matches symbols by contract root", () => {
    expect(symbolRoot("BT.MNQ")).toBe("MNQ");
    expect(symbolRoot("other")).toBe("OTHER");
    expect(() => assertSymbolAllowed(cfg({ BACKTESTER_ALLOWED_SYMBOLS: "mnq,MES" }), "BT.MNQ")).not.toThrow();
    expect(() => assertSymbolAllowed(cfg({ BACKTESTER_ALLOWED_SYMBOLS: "MES" }), "BT.NQ")).toThrow(/NQ is not in/);
  });

  it("limits order size", () => {
    expect(() => assertOrderSize(cfg(), 2)).toThrow(/BACKTESTER_MAX_ORDER_SIZE/);
    expect(() => assertOrderSize(cfg(), 1)).not.toThrow();
  });

  it("allows risk-reducing orders past the position limit", () => {
    const c = cfg({ BACKTESTER_MAX_POSITION_SIZE: "2" });
    expect(() => assertPositionLimit(c, { currentNet: 2, pendingSameSide: 0, side: "buy", size: 1 })).toThrow(/net position to 3/);
    expect(() => assertPositionLimit(c, { currentNet: 3, pendingSameSide: 0, side: "sell", size: 1 })).not.toThrow();
    expect(() => assertPositionLimit(c, { currentNet: -2, pendingSameSide: 0, side: "sell", size: 1 })).toThrow();
    expect(() => assertPositionLimit(c, { currentNet: 1, pendingSameSide: 1, side: "buy", size: 1 })).toThrow();
  });

  it("treats a reversal through flat as increasing exposure only if it ends larger", () => {
    expect(increasesExposure({ currentNet: 1, pendingSameSide: 0, side: "sell", size: 2 })).toBe(false);
    expect(increasesExposure({ currentNet: 1, pendingSameSide: 0, side: "sell", size: 3 })).toBe(true);
  });

  it("treats any part of an order beyond flat as new exposure", () => {
    expect(opensExposure({ currentNet: 1, pendingSameSide: 0, side: "sell", size: 2 })).toBe(true);
    expect(opensExposure({ currentNet: 1, pendingSameSide: 0, side: "sell", size: 1 })).toBe(false);
    expect(opensExposure({ currentNet: 0, pendingSameSide: 0, side: "buy", size: 1 })).toBe(true);
    expect(() => assertPositionLimit(cfg({ BACKTESTER_MAX_POSITION_SIZE: "1" }), { currentNet: 1, pendingSameSide: 0, side: "sell", size: 3 })).toThrow(/net position to -2/);
  });

  it("enforces the daily loss limit on realized net P&L", () => {
    const trades = [
      { profitAndLoss: null, fees: 1.4, voided: false },
      { profitAndLoss: -300, fees: 1.4, voided: false },
      { profitAndLoss: -1000, fees: 1.4, voided: true },
    ];
    expect(realizedNet(trades)).toBeCloseTo(-302.8);
    expect(() => assertDailyLoss(cfg({ BACKTESTER_MAX_DAILY_LOSS: "300" }), realizedNet(trades))).toThrow(/Daily loss/);
    expect(() => assertDailyLoss(cfg({ BACKTESTER_MAX_DAILY_LOSS: "500" }), realizedNet(trades))).not.toThrow();
    expect(() => assertDailyLoss(cfg({ BACKTESTER_MAX_DAILY_LOSS: "0" }), -1e6)).not.toThrow();
  });

  it("refuses orders outside the replay window", () => {
    const c = cfg({ BACKTESTER_START: "2024-03-04T00:00:00Z", BACKTESTER_END: "2024-03-08T00:00:00Z" });
    expect(() => assertInWindow(c, new Date("2024-03-03T23:59:00Z"))).toThrow(/before BACKTESTER_START/);
    expect(() => assertInWindow(c, new Date("2024-03-08T00:01:00Z"))).toThrow(/after BACKTESTER_END/);
    expect(() => assertInWindow(c, new Date("2024-03-05T15:00:00Z"))).not.toThrow();
    expect(() => assertInWindow(cfg(), new Date(0))).not.toThrow();
  });
});

describe("tradingDayStart", () => {
  it("is 17:00 Chicago (18:00 ET) the previous day before 5pm (CDT)", () => {
    expect(tradingDayStart(new Date("2025-07-16T15:00:00Z")).toISOString()).toBe("2025-07-15T22:00:00.000Z");
  });
  it("is 17:00 Chicago the same day after 5pm (CST)", () => {
    expect(tradingDayStart(new Date("2025-01-16T00:30:00Z")).toISOString()).toBe("2025-01-15T23:00:00.000Z");
    // cached per hour: the same answer again
    expect(tradingDayStart(new Date("2025-01-16T00:45:00Z")).toISOString()).toBe("2025-01-15T23:00:00.000Z");
  });
});
