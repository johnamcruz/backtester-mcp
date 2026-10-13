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

  it("fills market orders at the replay moment by default; BACKTESTER_MARKET_FILL=next-bar keeps the earlier rule", () => {
    expect(loadConfig(base).marketFill).toBe("now");
    expect(loadConfig({ ...base, BACKTESTER_MARKET_FILL: " Next-Bar " }).marketFill).toBe("next-bar");
    expect(loadConfig({ ...base, BACKTESTER_MARKET_FILL: "now" }).marketFill).toBe("now");
    expect(() => loadConfig({ ...base, BACKTESTER_MARKET_FILL: "later" })).toThrow(/BACKTESTER_MARKET_FILL/);
    expect(publicConfig(loadConfig(base))).toMatchObject({ marketFill: "now" });
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

  it("turns the derived store on by default, off on request, and takes the order-book folder", () => {
    expect(loadConfig(base)).toMatchObject({ useStore: true, orderbookDir: null });
    expect(publicConfig(loadConfig(base)).store).toBe("on");
    expect(loadConfig({ ...base, BACKTESTER_STORE: "OFF", BACKTESTER_ORDERBOOK_DIR: "/ob" })).toMatchObject({ useStore: false, orderbookDir: "/ob" });
    expect(() => loadConfig({ ...base, BACKTESTER_STORE: "maybe" })).toThrow(/BACKTESTER_STORE must be "on" or "off"/);
  });

  it("get_bars' order-flow defaults: off with no windows unless BACKTESTER_BARS_ORDER_FLOW / BACKTESTER_BARS_FLOW_WINDOWS set them", () => {
    expect(loadConfig(base)).toMatchObject({ barsOrderFlow: false, barsFlowWindows: [] });
    expect(publicConfig(loadConfig(base)).flow).toEqual({ largePrint: 10, source: "history", barsOrderFlow: false, barsFlowWindows: [] });
    expect(publicConfig(loadConfig(base))).not.toHaveProperty("barsOrderFlow");
    const c = loadConfig({ ...base, BACKTESTER_BARS_ORDER_FLOW: " TRUE ", BACKTESTER_BARS_FLOW_WINDOWS: "5, 20,1,50" });
    expect(c).toMatchObject({ barsOrderFlow: true, barsFlowWindows: [5, 20, 1, 50] });
    expect(publicConfig(c).flow).toMatchObject({ barsOrderFlow: true, barsFlowWindows: [5, 20, 1, 50] });
    expect(loadConfig({ ...base, BACKTESTER_BARS_ORDER_FLOW: "false" }).barsOrderFlow).toBe(false);
    expect(() => loadConfig({ ...base, BACKTESTER_BARS_ORDER_FLOW: "yes" })).toThrow(/^BACKTESTER_BARS_ORDER_FLOW must be "true" or "false", got "yes"$/);
    expect(() => loadConfig({ ...base, BACKTESTER_BARS_ORDER_FLOW: "1" })).toThrow(/^BACKTESTER_BARS_ORDER_FLOW must be "true" or "false", got "1"$/);
    expect(loadConfig({ ...base, BACKTESTER_BARS_ORDER_FLOW: " False " }).barsOrderFlow).toBe(false);
    expect(() => loadConfig({ ...base, BACKTESTER_BARS_ORDER_FLOW: " yes " })).toThrow(/^BACKTESTER_BARS_ORDER_FLOW must be "true" or "false", got "yes"$/);
    expect(() => loadConfig({ ...base, BACKTESTER_BARS_ORDER_FLOW: " Maybe " })).toThrow(/^BACKTESTER_BARS_ORDER_FLOW must be "true" or "false", got "Maybe"$/);
    expect(loadConfig({ ...base, BACKTESTER_BARS_ORDER_FLOW: "  " }).barsOrderFlow).toBe(false);
  });

  it("refuses BACKTESTER_BARS_FLOW_WINDOWS outside the shared rule: whole numbers 1-50, no duplicates, at most 5", () => {
    const err = (v: string) => { try { loadConfig({ ...base, BACKTESTER_BARS_FLOW_WINDOWS: v }); } catch (e) { return (e as Error).message; } return "accepted"; };
    const notWhole = (item: string) => `BACKTESTER_BARS_FLOW_WINDOWS windows must be whole numbers from 1 to 50, got "${item}"`;
    for (const item of ["0x10", "1e1", "+5", "5.0", "-3", "five", "2.5"]) expect(err(item)).toBe(notWhole(item));
    expect(err("5,,20")).toBe(notWhole(""));
    expect(err("5,")).toBe(notWhole(""));
    expect(err("0")).toBe(notWhole("0"));
    expect(err("51")).toBe(notWhole("51"));
    // In order: the digits check over every item comes before the range check, the range before duplicates, duplicates before the count.
    expect(err("51,abc")).toBe(notWhole("abc"));
    expect(err("5,5,51")).toBe(notWhole("51"));
    expect(err("5,5")).toBe("BACKTESTER_BARS_FLOW_WINDOWS has a duplicate window 5");
    expect(err("5, 05")).toBe("BACKTESTER_BARS_FLOW_WINDOWS has a duplicate window 5");
    expect(err("1,2,3,4,5,6,6")).toBe("BACKTESTER_BARS_FLOW_WINDOWS has a duplicate window 6");
    expect(err("1,2,3,4,5,6")).toBe("BACKTESTER_BARS_FLOW_WINDOWS allows at most 5 windows");
    expect(loadConfig({ ...base, BACKTESTER_BARS_FLOW_WINDOWS: "1,2,3,4,5" }).barsFlowWindows).toEqual([1, 2, 3, 4, 5]);
    expect(loadConfig({ ...base, BACKTESTER_BARS_FLOW_WINDOWS: " 5 , 20 " }).barsFlowWindows).toEqual([5, 20]);
    expect(loadConfig({ ...base, BACKTESTER_BARS_FLOW_WINDOWS: "  " }).barsFlowWindows).toEqual([]);
  });
});
