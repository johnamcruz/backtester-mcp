import { describe, expect, it } from "vitest";
import { loadConfig, publicConfig } from "../src/config.js";

const base = { BACKTESTER_DATA_DIR: "/data", BACKTESTER_NOW: "2024-03-05T15:00:00Z" };

describe("config", () => {
  it("requires a data folder and a clock", () => {
    expect(() => loadConfig({})).toThrow(/BACKTESTER_DATA_DIR/);
    expect(() => loadConfig({ BACKTESTER_DATA_DIR: "/data" })).toThrow(/BACKTESTER_CLOCK_FILE/);
    expect(() => loadConfig({ ...base, BACKTESTER_NOW: "soon" })).toThrow(/BACKTESTER_NOW/);
  });

  it("defaults to trading disabled, conservative limits, and the documented replay settings", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      tradingEnabled: false, maxOrderSize: 1, maxPositionSize: 2, maxDailyLoss: 500, startBalance: 100000, slippageTicks: 1,
      feesMicro: 0.37, feesMini: 1.4, accountId: 1, runId: "default", start: null, end: null,
    });
    expect(c.stateDir).toMatch(/\.backtester-mcp\/runs\/default$/);
    expect(c.journalPath).toBe(`${c.stateDir}/journal.jsonl`);
    expect(c.statePath).toBe(`${c.stateDir}/state.json`);
  });

  it("parses lists, numbers, the window, the run, and ~ paths", () => {
    const c = loadConfig({
      ...base, BACKTESTER_ALLOWED_ACCOUNT_IDS: "1,2", BACKTESTER_ALLOWED_SYMBOLS: "mnq, mes", BACKTESTER_MAX_DAILY_LOSS: "0",
      BACKTESTER_JOURNAL_PATH: "~/j.jsonl", BACKTESTER_START: "2024-03-01", BACKTESTER_END: "2024-03-31T00:00:00Z", BACKTESTER_RUN_ID: "run-7",
    });
    expect(c).toMatchObject({ allowedAccountIds: [1, 2], allowedSymbols: ["MNQ", "MES"], maxDailyLoss: 0, runId: "run-7" });
    expect(c.start).toBe(Date.parse("2024-03-01T00:00:00Z"));
    expect(c.stateDir).toMatch(/runs\/run-7$/);
    expect(c.journalPath).not.toContain("~");
    const pub = publicConfig(c);
    expect(pub).toMatchObject({ maxDailyLoss: "off", allowedSymbols: ["MNQ", "MES"], allowedAccountIds: [1, 2], mode: "replay", replay: true, username: "replay" });
    expect(pub.window).toEqual({ start: "2024-03-01T00:00:00.000Z", end: "2024-03-31T00:00:00.000Z" });
    expect(publicConfig(loadConfig(base))).toMatchObject({ allowedAccountIds: "any", allowedSymbols: "any", clock: { fixed: base.BACKTESTER_NOW } });
  });

  it("rejects bad values", () => {
    expect(() => loadConfig({ ...base, BACKTESTER_MAX_ORDER_SIZE: "-1" })).toThrow(/non-negative/);
    expect(() => loadConfig({ ...base, BACKTESTER_ALLOWED_ACCOUNT_IDS: "abc" })).toThrow(/non-integer/);
    expect(() => loadConfig({ ...base, BACKTESTER_START: "nope" })).toThrow(/BACKTESTER_START/);
    expect(() => loadConfig({ ...base, BACKTESTER_START: "2024-03-02", BACKTESTER_END: "2024-03-01" })).toThrow(/after BACKTESTER_START/);
    expect(() => loadConfig({ ...base, BACKTESTER_RUN_ID: "../x" })).toThrow(/BACKTESTER_RUN_ID/);
    expect(() => loadConfig({ ...base, BACKTESTER_ACCOUNT_ID: "1.5" })).toThrow(/integer/);
    expect(() => loadConfig({ ...base, BACKTESTER_START_BALANCE: "0" })).toThrow(/positive/);
  });
});
