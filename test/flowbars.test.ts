import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flowRange, flowSourceContract, plainFlow, spanMinutes } from "../src/flowtools.js";
import { buildStore } from "../src/storebuild.js";
import { flat, setup, writeData } from "./helpers.js";
import { Z, builtStore } from "./storefixture.js";

/**
 * get_bars with includeOrderFlow over the March 2024 store fixture: 2024-03-07 14:30Z has a
 * quote 17999.75 x 18000 and prints 18000 (buy, at the ask), 18001.5 (buy), 17999.25 (sell, at
 * the bid), size 1 each; 14:31Z a quote 18001.75 x 18002 and a buy at 18002.
 */
async function world(now: string, env: Record<string, string> = {}, flow = true) {
  const b = flow ? await builtStore() : await (async () => {
    const x = await builtStore();
    await buildStore({ source: x.source, dataDir: join(x.dir, "noflow"), from: "202403", to: "202403", flow: false });
    return { ...x, dataDir: join(x.dir, "noflow") };
  })();
  writeData(b.dataDir, { NQ: flat(Z("2024-03-05T14:00:00Z"), 60, 20000), ES: flat(Z("2024-03-07T14:00:00Z"), 60, 5000) });
  return setup({ dir: b.dir, now: Z(now), env: { BACKTESTER_DATA_DIR: b.dataDir, ...env } });
}

const minuteBars = (extra: Record<string, unknown> = {}) => ({ unit: "minute", unitNumber: 1, limit: 10, includeOrderFlow: true, ...extra });

describe("get_bars order flow", () => {
  it("is off by default: the bars are unchanged, with no flow and no orderFlow", async () => {
    const { call } = await world("2024-03-07T14:35:00Z");
    const plain = (await call("get_bars", { contractId: "BT.MNQ.H24", unit: "minute", unitNumber: 1, limit: 10 })).data;
    expect(Object.keys(plain).sort()).toEqual(["barSize", "bars", "contractId", "count"]);
    expect(plain.bars.every((b: any) => !("flow" in b))).toBe(true);
    const withFlow = (await call("get_bars", { contractId: "BT.MNQ.H24", ...minuteBars() })).data;
    expect(withFlow.bars.map(({ flow: _f, ...b }: any) => b)).toEqual(plain.bars);
  });

  it("sums each bar's minutes, with windows; MNQ bars carry NQ's flow", async () => {
    const { call } = await world("2024-03-07T14:35:00Z");
    const mnq = (await call("get_bars", { contractId: "BT.MNQ.H24", ...minuteBars({ flowWindows: [3, 2, 2] }) })).data;
    expect(mnq.count).toBe(2);
    expect(mnq.bars[0].flow).toEqual({
      bv: 2, sv: 1, delta: 1, trades: 3, volume: 3, vwap: 18000.25, ofiTrade: 1 / 3, ofiQuote: 0, imbalance: expect.any(Number), largeBuy: 0, largeSell: 0, complete: true,
      windows: { "2": { ofiTrade: null, delta: null }, "3": { ofiTrade: null, delta: null } },
    });
    expect(mnq.bars[1].flow).toMatchObject({ bv: 1, sv: 0, delta: 1, complete: true, windows: { "2": { ofiTrade: 0.5, delta: 2 }, "3": { ofiTrade: null, delta: null } } });
    expect(mnq.orderFlow).toMatchObject({ sourceContractId: "BT.NQ.H24", largePrint: 10, windows: [2, 3], coverage: { source: "history", inferredSide: true, unvalidated: ["ofiQuote"] } });
    expect(mnq.orderFlow.note).toMatch(/complete=true means.*ofiQuote is unvalidated/);
    const nq = (await call("get_bars", { contractId: "BT.NQ.H24", ...minuteBars({ flowWindows: [2, 3] }) })).data;
    expect(nq.bars.map((b: any) => b.flow)).toEqual(mnq.bars.map((b: any) => b.flow));
    expect(nq.orderFlow.sourceContractId).toBe("BT.NQ.H24");
  });

  it("the bar still forming (includePartialBar) is incomplete until its last minute is over", async () => {
    const twoMinute = minuteBars({ unitNumber: 2, includePartialBar: true });
    const during = await world("2024-03-07T14:31:30Z");
    const r = (await during.call("get_bars", { contractId: "BT.MNQ.H24", ...twoMinute })).data;
    expect(r.bars.map((b: any) => [b.t, b.flow.complete, b.flow.bv])).toEqual([["2024-03-07T14:30:00.000Z", false, null]]);
    const after = await world("2024-03-07T14:32:00Z");
    const s = (await after.call("get_bars", { contractId: "BT.MNQ.H24", ...twoMinute })).data;
    expect(s.bars.map((b: any) => [b.t, b.flow.complete, b.flow.bv])).toEqual([["2024-03-07T14:30:00.000Z", true, 3]]);
  });

  it("hour bars carry flow (incomplete when a minute has no data); day bars carry none, with a note", async () => {
    const { call } = await world("2024-03-07T16:00:00Z");
    const hour = (await call("get_bars", { contractId: "BT.MNQ.H24", unit: "hour", unitNumber: 1, limit: 5, includeOrderFlow: true })).data;
    expect(hour.bars.at(-1).flow.complete).toBe(false);
    expect(hour.orderFlow.note).toMatch(/complete=true means/);
    const day = (await call("get_bars", { contractId: "BT.MNQ.H24", unit: "day", unitNumber: 1, limit: 5, includeOrderFlow: true, flowWindows: [2] })).data;
    expect(day.orderFlow).toEqual({ sourceContractId: "BT.NQ.H24", largePrint: 10, windows: [2], note: "Order flow is built from minutes: only minute and hour bars carry it." });
    expect(day.bars.every((b: any) => b.flow.complete === false && b.flow.bv === null && b.flow.windows["2"].delta === null)).toBe(true);
  });

  it("the large-print threshold is BACKTESTER_FLOW_LARGE_PRINT", async () => {
    const { call } = await world("2024-03-07T14:35:00Z", { BACKTESTER_FLOW_LARGE_PRINT: "1" });
    const r = (await call("get_bars", { contractId: "BT.MNQ.H24", ...minuteBars() })).data;
    expect(r.orderFlow.largePrint).toBe(1);
    expect([r.bars[0].flow.largeBuy, r.bars[0].flow.largeSell]).toEqual([2, 1]);
    expect((await call("get_server_config", {})).data.flow).toEqual({ largePrint: 1, source: "history", barsOrderFlow: false, barsFlowWindows: [] });
  });

  it("contracts without order-flow history get empty flow and a note: the CSV series, MES (no ES data)", async () => {
    const csv = await world("2024-03-05T14:30:00Z", { BACKTESTER_STORE: "off" });
    const r = (await csv.call("get_bars", { contractId: "BT.MNQ", ...minuteBars() })).data;
    expect(r.count).toBeGreaterThan(0);
    expect(r.bars.every((b: any) => b.flow.complete === false)).toBe(true);
    expect(r.orderFlow).toMatchObject({ sourceContractId: "BT.NQ", note: expect.stringMatching(/back-adjusted CSV series BT.MNQ carries none/) });
    const es = await world("2024-03-07T14:30:00Z");
    const m = (await es.call("get_bars", { contractId: "BT.MES", ...minuteBars() })).data;
    expect(m.orderFlow).toMatchObject({ sourceContractId: "BT.ES", note: "No order-flow history for BT.ES: the local order-book data is NQ only." });
    expect(m.bars.length).toBeGreaterThan(0);
    expect(m.bars.every((b: any) => b.flow.complete === false)).toBe(true);
  });

  it("a store built without order flow: empty flow and a note", async () => {
    const { call } = await world("2024-03-07T14:35:00Z", {}, false);
    const r = (await call("get_bars", { contractId: "BT.MNQ.H24", ...minuteBars() })).data;
    expect(r.orderFlow.note).toMatch(/has no order flow: build it with build-store/);
    expect(r.bars.every((b: any) => b.flow.complete === false)).toBe(true);
  });

  it("no bar: the note says so", async () => {
    const { call } = await world("2024-03-07T14:35:00Z");
    const r = (await call("get_bars", { contractId: "BT.MNQ.H24", ...minuteBars({ endTime: "2024-03-07T10:00:00Z" }) })).data;
    expect(r).toMatchObject({ count: 0, bars: [], orderFlow: { note: "No bar has a usable time." } });
  });

  it("BACKTESTER_BARS_ORDER_FLOW and BACKTESTER_BARS_FLOW_WINDOWS are the defaults for calls that leave the arguments out", async () => {
    const plainArgs = { contractId: "BT.MNQ.H24", unit: "minute", unitNumber: 1, limit: 10 };
    const off = await world("2024-03-07T14:35:00Z", { BACKTESTER_BARS_FLOW_WINDOWS: "2" });
    const plain = (await off.call("get_bars", plainArgs)).data;
    expect(Object.keys(plain).sort()).toEqual(["barSize", "bars", "contractId", "count"]);
    expect((await off.call("get_bars", { ...plainArgs, includeOrderFlow: true })).data.orderFlow.windows).toEqual([2]);
    expect((await off.call("get_bars", { ...plainArgs, includeOrderFlow: true, flowWindows: [3] })).data.orderFlow.windows).toEqual([3]);
    expect((await off.call("get_bars", { ...plainArgs, includeOrderFlow: true, flowWindows: [] })).data.orderFlow.windows).toEqual([]);

    const on = await world("2024-03-07T14:35:00Z", { BACKTESTER_BARS_ORDER_FLOW: "true" });
    const byDefault = (await on.call("get_bars", plainArgs)).data;
    expect(byDefault.bars[0].flow).toMatchObject({ bv: 2, sv: 1, delta: 1, complete: true });
    expect(byDefault.orderFlow.windows).toEqual([]);
    expect(byDefault).toEqual((await off.call("get_bars", { ...plainArgs, includeOrderFlow: true, flowWindows: [] })).data);
    expect((await on.call("get_bars", { ...plainArgs, includeOrderFlow: false })).data).toEqual(plain);

    const both = await world("2024-03-07T14:35:00Z", { BACKTESTER_BARS_ORDER_FLOW: "true", BACKTESTER_BARS_FLOW_WINDOWS: "3,2" });
    const r = (await both.call("get_bars", plainArgs)).data;
    expect(r.orderFlow.windows).toEqual([2, 3]);
    expect(r.bars[1].flow.windows).toEqual({ "2": { ofiTrade: 0.5, delta: 2 }, "3": { ofiTrade: null, delta: null } });
    expect((await both.call("get_bars", { ...plainArgs, flowWindows: [2] })).data.orderFlow.windows).toEqual([2]);
    expect((await both.call("get_server_config", {})).data.flow).toEqual({ largePrint: 10, source: "history", barsOrderFlow: true, barsFlowWindows: [3, 2] });
  });

  it("get_bars' descriptions are static: tools/list is the same with the env on and off, and never shows env values", async () => {
    const tools = async (env: Record<string, string>) => (await (await world("2024-03-07T14:35:00Z", env)).client.listTools()).tools;
    const off = await tools({});
    const on = await tools({ BACKTESTER_BARS_ORDER_FLOW: "true", BACKTESTER_BARS_FLOW_WINDOWS: "5,20" });
    expect(on).toEqual(off);
    const bars = off.find((t) => t.name === "get_bars")!;
    expect(bars.description).toContain("includeOrderFlow=true (default: this server's configuration, see get_server_config flow.barsOrderFlow) adds `flow`");
    const props = bars.inputSchema.properties as Record<string, { description?: string; default?: unknown }>;
    expect(props.includeOrderFlow!.description).toContain("Default: the server's BACKTESTER_BARS_ORDER_FLOW (false unless set)");
    expect(props.flowWindows!.description).toContain("Default: the server's BACKTESTER_BARS_FLOW_WINDOWS (none unless set)");
    expect(props.includeOrderFlow!.default).toBeUndefined();
    expect(props.flowWindows!.default).toBeUndefined();
  });

  it("refuses more than 5 windows or a window outside 1-50, as projectx-mcp", async () => {
    const { call } = await world("2024-03-07T14:35:00Z");
    expect((await call("get_bars", { contractId: "BT.MNQ.H24", ...minuteBars({ flowWindows: [1, 2, 3, 4, 5, 6] }) })).isError).toBe(true);
    expect((await call("get_bars", { contractId: "BT.MNQ.H24", ...minuteBars({ flowWindows: [51] }) })).isError).toBe(true);
    expect((await call("get_bars", { contractId: "BT.MNQ.H24", ...minuteBars({ flowWindows: [0] }) })).isError).toBe(true);
  });
});

describe("flow tool helpers", () => {
  it("map micros to their full-size contract (MNQ -> NQ, MES -> ES), keep others", () => {
    expect(flowSourceContract("BT.MNQ.M24")).toBe("BT.NQ.M24");
    expect(flowSourceContract("BT.MNQ")).toBe("BT.NQ");
    expect(flowSourceContract("BT.MES")).toBe("BT.ES");
    expect(flowSourceContract("BT.NQ.M24")).toBe("BT.NQ.M24");
    expect(flowSourceContract("BT.MGC")).toBe("BT.MGC");
    expect(flowSourceContract("X")).toBe("X");
  });

  it("span, range and plain flow", () => {
    expect([spanMinutes("minute", 5), spanMinutes("hour", 2), spanMinutes("day", 1), spanMinutes("week", 1)]).toEqual([5, 120, null, null]);
    const bars = [{ t: "2024-03-07T14:30:00.000Z" }, { t: "2024-03-07T14:35:00.000Z" }, { t: "bad" }];
    // Windows of 3 reach two spans before the first bar; the last bar's span ends 4 minutes after its start.
    expect(flowRange(bars, 5, [3, 1])).toEqual({ from: Z("2024-03-07T14:20:00Z"), to: Z("2024-03-07T14:39:00Z") });
    expect(flowRange([{ t: "bad" }], 5, [])).toBeNull();
    expect(plainFlow([{ t: "x" }], [2])[0].flow).toMatchObject({ complete: false, bv: null, windows: { "2": { ofiTrade: null, delta: null } } });
  });
});
