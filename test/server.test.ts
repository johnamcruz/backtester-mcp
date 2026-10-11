import { describe, expect, it } from "vitest";
import { MIN, RATIONALE, T0, flat, iso, seq, setup } from "./helpers.js";

const order = { accountId: 1, contractId: "BT.MNQ", side: "buy", type: "market", size: 1, rationale: RATIONALE };

// projectx-mcp's tools and input fields (src/server.ts there): this server is a drop-in replacement.
const PROJECTX_INPUTS: Record<string, string[]> = {
  get_server_config: [],
  list_accounts: ["onlyActiveAccounts"],
  get_account_snapshot: ["accountId"],
  search_contracts: ["searchText", "live"],
  get_contract: ["contractId"],
  list_available_contracts: ["live"],
  get_bars: ["contractId", "unit", "unitNumber", "limit", "startTime", "endTime", "includePartialBar", "live"],
  get_quote: ["contractId", "timeoutMs"],
  list_open_orders: ["accountId"],
  search_orders: ["accountId", "startTimestamp", "endTimestamp"],
  list_open_positions: ["accountId"],
  search_trades: ["accountId", "startTimestamp", "endTimestamp"],
  get_performance: ["accountId", "startTimestamp", "endTimestamp"],
  place_order: ["accountId", "contractId", "side", "type", "size", "limitPrice", "stopPrice", "trailPrice", "stopLossBracket", "takeProfitBracket", "customTag", "rationale"],
  modify_order: ["accountId", "orderId", "size", "limitPrice", "stopPrice", "trailPrice", "reason"],
  cancel_order: ["accountId", "orderId"],
  close_position: ["accountId", "contractId", "reason"],
  partial_close_position: ["accountId", "contractId", "size", "reason"],
  journal_add: ["kind", "text", "accountId", "contractId", "orderId", "tags"],
  journal_read: ["kind", "tag", "contractId", "since", "limit"],
};
const REQUIRED: Record<string, string[]> = {
  get_account_snapshot: ["accountId"], search_contracts: ["searchText"], get_contract: ["contractId"], get_bars: ["contractId"],
  get_quote: ["contractId"], list_open_orders: ["accountId"], search_orders: ["accountId", "startTimestamp"], list_open_positions: ["accountId"],
  search_trades: ["accountId"], get_performance: ["accountId"], place_order: ["accountId", "contractId", "side", "type", "size", "rationale"],
  modify_order: ["accountId", "orderId"], cancel_order: ["accountId", "orderId"], close_position: ["accountId", "contractId"],
  partial_close_position: ["accountId", "contractId", "size"], journal_add: ["kind", "text"],
};

describe("tool registry", () => {
  it("exposes projectx-mcp's tools with the same input fields and read/write annotations", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(Object.keys(PROJECTX_INPUTS).sort());
    for (const [name, fields] of Object.entries(PROJECTX_INPUTS)) {
      const schema = byName[name].inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(Object.keys(schema.properties ?? {}).sort(), name).toEqual([...fields].sort());
      expect([...(schema.required ?? [])].sort(), name).toEqual([...(REQUIRED[name] ?? [])].sort());
    }
    for (const w of ["place_order", "modify_order", "cancel_order", "close_position", "partial_close_position"]) {
      expect(byName[w].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(byName.get_bars.annotations?.readOnlyHint).toBe(true);
    const bars = byName.get_bars.inputSchema as { properties: Record<string, { default?: unknown; enum?: unknown }> };
    expect(bars.properties.unit).toMatchObject({ default: "minute", enum: ["second", "minute", "hour", "day", "week", "month"] });
    expect(bars.properties.unitNumber.default).toBe(5);
    expect(bars.properties.limit.default).toBe(100);
  });

  it("serves the guide resource and the session prompt", async () => {
    const { client } = await setup();
    const res = await client.readResource({ uri: "backtester://guide" });
    expect((res.contents[0] as { text: string }).text).toMatch(/For the trading agent/);
    const prompt = await client.getPrompt({ name: "trading_session", arguments: { focus: "MNQ" } });
    expect(JSON.stringify(prompt.messages)).toMatch(/focused on MNQ/);
  });

  it("sends server instructions on initialize", async () => {
    const { client } = await setup();
    expect(client.getInstructions()).toMatch(/backtester:\/\/guide/);
    expect(client.getServerVersion()?.name).toBe("backtester-mcp");
  });
});

describe("read tools", () => {
  it("get_server_config reports guardrails, the replay window, the clock, and the data ranges", async () => {
    const { data } = await (await setup({ env: { BACKTESTER_START: "2024-03-01", BACKTESTER_END: "2024-03-31" } })).call("get_server_config");
    expect(data).toMatchObject({
      tradingEnabled: true, maxOrderSize: 1, maxPositionSize: 2, maxDailyLoss: 500, allowedAccountIds: "any", allowedSymbols: "any",
      mode: "replay", replay: true, window: { start: "2024-03-01T00:00:00.000Z", end: "2024-03-31T00:00:00.000Z" },
      serverTime: iso(T0), tradingDayStartedAt: "2024-03-04T23:00:00.000Z",
      data: { NQ: { file: "NQ_1min.csv" }, MNQ: { file: "NQ_1min.csv" } },
    });
    expect(data.clock).toMatchObject({ now: iso(T0) });
    expect(typeof data.journalPath).toBe("string");
  });

  it("explains a missing clock", async () => {
    const { call, dir } = await setup();
    const { rmSync } = await import("node:fs");
    rmSync(`${dir}/clock.json`);
    const res = await call("get_server_config");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not exist yet/);
  });

  it("list_accounts flags which accounts the MCP may trade", async () => {
    expect((await (await setup()).call("list_accounts")).data).toEqual([
      { id: 1, name: "BACKTEST-default", balance: 100000, canTrade: true, isVisible: true, simulated: true, mcpTradingAllowed: true },
    ]);
    expect((await (await setup({ env: { BACKTESTER_ALLOWED_ACCOUNT_IDS: "2" } })).call("list_accounts")).data[0].mcpTradingAllowed).toBe(false);
    expect((await (await setup({ env: { BACKTESTER_TRADING_ENABLED: "false" } })).call("list_accounts")).data[0].mcpTradingAllowed).toBe(false);
  });

  it("get_account_snapshot combines balance, positions, orders, and today's P&L", async () => {
    const { call } = await setup();
    await call("place_order", { ...order, stopLossBracket: { ticks: 20, type: "stop" } });
    const { data } = await call("get_account_snapshot", { accountId: 1 });
    expect(data.account).toMatchObject({ id: 1, balance: 99999.63 });
    expect(data.positions).toMatchObject([{ direction: "long", size: 1, averagePrice: 20000.25 }]);
    expect(data.openOrders).toMatchObject([{ statusName: "open", typeName: "stop", sideName: "sell", stopPrice: 19995.25 }]);
    expect(data.today).toMatchObject({ tradingDayStartedAt: "2024-03-04T23:00:00.000Z", realizedNetPnL: -0.37, dailyLossLimit: 500, remainingBeforeLimit: 499.63, fills: 1 });
  });

  it("contract lookups", async () => {
    const { call } = await setup();
    expect((await call("search_contracts", { searchText: "MNQ" })).data).toMatchObject([{ id: "BT.MNQ", name: "MNQH24", activeContract: true }]);
    expect((await call("get_contract", { contractId: "BT.NQ" })).data).toMatchObject({ id: "BT.NQ", tickValue: 5 });
    expect((await call("list_available_contracts")).data.map((c: any) => c.id)).toEqual(["BT.NQ", "BT.MNQ"]);
    const missing = await call("get_contract", { contractId: "nope" });
    expect(missing).toMatchObject({ isError: true, text: expect.stringMatching(/not found/) });
  });

  it("get_bars returns closed bars oldest first in projectx-mcp's shape", async () => {
    const { call } = await setup();
    const { data } = await call("get_bars", { contractId: "BT.MNQ", unit: "minute", unitNumber: 1, limit: 2 });
    expect(data).toEqual({
      contractId: "BT.MNQ", barSize: "1 minute", count: 2,
      bars: [{ t: iso(T0 - 2 * MIN), o: 20000, h: 20000, l: 20000, c: 20000, v: 10 }, { t: iso(T0 - MIN), o: 20000, h: 20000, l: 20000, c: 20000, v: 10 }],
    });
    expect((await call("get_bars", { contractId: "BT.MNQ" })).data.barSize).toBe("5 minute");
    expect((await call("get_bars", { contractId: "BT.MNQ", unit: "second" })).isError).toBe(true);
  });

  it("get_quote returns the last close or a helpful null", async () => {
    const { call, setNow } = await setup();
    expect((await call("get_quote", { contractId: "BT.MNQ" })).data).toMatchObject({ contractId: "BT.MNQ", ageMs: 0, quote: { lastPrice: 20000 } });
    setNow(T0 + 5 * 60 * MIN);
    expect((await call("get_quote", { contractId: "BT.MNQ" })).data).toMatchObject({ quote: null, note: expect.stringMatching(/closed/) });
  });

  it("order, position, and trade searches decorate enums", async () => {
    const { call } = await setup();
    await call("place_order", order);
    await call("place_order", { ...order, side: "sell", type: "limit", limitPrice: 20010, customTag: "tp-1" });
    expect((await call("search_orders", { accountId: 1, startTimestamp: iso(T0) })).data).toMatchObject([
      { id: 1, statusName: "filled", typeName: "market", sideName: "buy", filledPrice: 20000.25, fillVolume: 1 },
      { id: 2, statusName: "open", typeName: "limit", sideName: "sell", customTag: "tp-1" },
    ]);
    expect((await call("list_open_orders", { accountId: 1 })).data).toMatchObject([{ id: 2, typeName: "limit" }]);
    expect((await call("list_open_positions", { accountId: 1 })).data[0].direction).toBe("long");
    expect((await call("search_trades", { accountId: 1 })).data[0]).toMatchObject({ sideName: "buy", halfTurn: true });
    expect((await call("search_trades", { accountId: 1, startTimestamp: iso(T0 + MIN) })).data).toEqual([]);
  });

  it("get_performance summarizes a window", async () => {
    const { call, setNow } = await setup({ data: { NQ: [...flat(T0 - 10 * MIN, 11, 20000), ...flat(T0 + MIN, 5, 20010)] } });
    await call("place_order", order);
    setNow(T0 + 2 * MIN);
    await call("close_position", { accountId: 1, contractId: "BT.MNQ" });
    const { data } = await call("get_performance", { accountId: 1 });
    expect(data.window).toEqual({ start: "2024-03-04T23:00:00.000Z", end: "now" });
    expect(data.overall).toMatchObject({ wins: 1, grossPnL: 19, fees: 0.74, netPnL: 18.26 });
    expect(data.byContract["BT.MNQ"].wins).toBe(1);
  });

  it("surfaces an unknown account as a tool error", async () => {
    const res = await (await setup()).call("list_open_positions", { accountId: 9 });
    expect(res).toMatchObject({ isError: true, text: expect.stringMatching(/Account 9 not found/) });
  });
});

describe("place_order", () => {
  it("sends brackets and journals the rationale with the replay time", async () => {
    const { call, journal } = await setup();
    const res = await call("place_order", { ...order, stopLossBracket: { ticks: 20, type: "stop" }, takeProfitBracket: { ticks: 40, type: "limit" }, customTag: "fth-1" });
    expect(res.isError).toBe(false);
    expect(res.data).toEqual({ orderId: 1, success: true, errorCode: 0, errorName: "Success", errorMessage: null });
    const [entry] = await journal.read({ kind: "order_placed" });
    expect(entry).toMatchObject({ ts: iso(T0), text: RATIONALE, orderId: 1, contractId: "BT.MNQ", data: { result: { success: true }, positionBefore: 0 } });
    expect((await call("list_open_orders", { accountId: 1 })).data.map((o: any) => [o.typeName, o.stopPrice ?? o.limitPrice])).toEqual([["stop", 19995.25], ["limit", 20010.25]]);
  });

  it("reports refusals with the error name, sets isError, and journals them", async () => {
    const { call, journal } = await setup({ now: T0 + 5 * 60 * MIN });
    const res = await call("place_order", order);
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ orderId: null, errorCode: 5, errorName: "OutsideTradingHours" });
    expect((await journal.read({ kind: "order_placed" }))[0].data).toMatchObject({ result: { success: false, errorCode: 5 } });
  });

  it.each([
    [{ type: "limit" }, /limitPrice/],
    [{ type: "stop" }, /stopPrice/],
    [{ type: "trailing_stop" }, /trailPrice/],
  ])("requires the price for %o", async (patch, msg) => {
    const { call } = await setup();
    const res = await call("place_order", { ...order, ...patch });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(msg);
    expect((await call("search_orders", { accountId: 1, startTimestamp: iso(T0 - MIN) })).data).toEqual([]);
  });

  it("is refused and journaled when trading is disabled", async () => {
    const { call, journal } = await setup({ env: { BACKTESTER_TRADING_ENABLED: "false" } });
    const res = await call("place_order", order);
    expect(res.text).toMatch(/Blocked by risk guardrail: Trading is disabled/);
    expect((await journal.read({ kind: "order_blocked" }))[0].text).toContain(RATIONALE);
  });

  it("enforces symbol and order-size limits", async () => {
    const { call } = await setup({ env: { BACKTESTER_ALLOWED_SYMBOLS: "NQ", BACKTESTER_MAX_ORDER_SIZE: "1" } });
    expect((await call("place_order", order)).text).toMatch(/MNQ is not in/);
    expect((await call("place_order", { ...order, contractId: "BT.NQ", size: 2 })).text).toMatch(/exceeds BACKTESTER_MAX_ORDER_SIZE/);
  });

  it("counts the open position and resting same-side entries (and waiting market orders) against the position limit", async () => {
    const { call } = await setup({ env: { BACKTESTER_MAX_POSITION_SIZE: "2" } });
    await call("place_order", order); // long 1
    await call("place_order", { ...order, type: "limit", limitPrice: 19990 }); // resting buy limit: counts
    await call("place_order", { ...order, side: "sell", type: "stop", stopPrice: 19980 }); // protective stop: ignored
    expect((await call("place_order", order)).text).toMatch(/net position to 3/);
    expect((await call("place_order", { ...order, side: "sell" })).isError).toBe(false);
    const mid = await setup({ now: T0 + 30000, env: { BACKTESTER_MAX_POSITION_SIZE: "1" } });
    await mid.call("place_order", order); // waits for the next bar
    expect((await mid.call("place_order", order)).text).toMatch(/net position to 2/);
  });

  it("blocks new risk after the daily loss limit but still allows exits", async () => {
    const data = { NQ: [...flat(T0 - 10 * MIN, 10, 20000), ...flat(T0, 2, 20000), ...flat(T0 + 2 * MIN, 10, 19700)] };
    const { call, setNow } = await setup({ data, env: { BACKTESTER_MAX_DAILY_LOSS: "200", BACKTESTER_MAX_POSITION_SIZE: "5", BACKTESTER_MAX_ORDER_SIZE: "5" } });
    await call("place_order", { ...order, contractId: "BT.NQ", size: 1 }); // NQ long 1 at 20000.25
    await call("place_order", { ...order, contractId: "BT.MNQ", side: "sell" }); // MNQ short 1, kept open
    setNow(T0 + 2 * MIN);
    await call("close_position", { accountId: 1, contractId: "BT.NQ" }); // sells at 19699.75: -300.5 points x $20 = -$6,010
    expect((await call("get_account_snapshot", { accountId: 1 })).data.today.realizedNetPnL).toBeLessThan(-200);
    expect((await call("place_order", { ...order, side: "sell" })).text).toMatch(/Daily loss limit reached/);
    expect((await call("place_order", { ...order, side: "buy" })).isError).toBe(false); // covers the short
  });

  it("counts same-side stop entries, and checks a resting order whose size grows", async () => {
    const { call } = await setup({ env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2" } });
    await call("place_order", { ...order, type: "stop", stopPrice: 20010, size: 2 }); // a buy stop entry while flat
    expect((await call("place_order", { ...order, size: 1 })).text).toMatch(/net position to 3/);
    const m = await setup({ env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2" } });
    await m.call("place_order", { ...order, type: "limit", limitPrice: 19990 });
    await m.call("place_order", { ...order, type: "limit", limitPrice: 19985 });
    expect((await m.call("modify_order", { accountId: 1, orderId: 2, size: 2 })).text).toMatch(/net position to 3/);
    expect((await m.call("modify_order", { accountId: 1, orderId: 2, size: 1 })).data.success).toBe(true);
  });

  it("counts the part of a stop against the position that would reverse it", async () => {
    const { call } = await setup({ env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "3" } });
    await call("place_order", { ...order, side: "sell" }); // short 1
    expect((await call("place_order", { ...order, type: "stop", stopPrice: 20010, size: 3 })).data.success).toBe(true); // projected +2
    expect((await call("place_order", { ...order, type: "limit", limitPrice: 19990, size: 2 })).text).toMatch(/net position to 3/); // -1 + 2 (stop beyond the short) + 2
  });

  it("lets a protective order grow to cover the position after the daily loss limit", async () => {
    const data = { NQ: [...flat(T0 - 10 * MIN, 12, 20000), ...flat(T0 + 2 * MIN, 10, 19999)] };
    const { call, setNow } = await setup({ data, env: { BACKTESTER_MAX_DAILY_LOSS: "1", BACKTESTER_MAX_ORDER_SIZE: "2", BACKTESTER_MAX_POSITION_SIZE: "2" } });
    await call("place_order", { ...order, size: 2, takeProfitBracket: { ticks: 40, type: "limit" } }); // long 2, TP leg sells 2
    await call("place_order", { ...order, side: "sell", type: "limit", limitPrice: 20005 }); // scale-out
    const stop = await call("place_order", { ...order, side: "sell", type: "stop", stopPrice: 19990 });
    await call("place_order", { ...order, contractId: "BT.NQ" });
    setNow(T0 + 2 * MIN);
    await call("close_position", { accountId: 1, contractId: "BT.NQ" });
    expect((await call("place_order", { ...order, size: 1 })).text).toMatch(/Daily loss limit reached/);
    expect((await call("modify_order", { accountId: 1, orderId: stop.data.orderId, size: 2 })).data.success).toBe(true);
  });

  it("doesn't let several orders against the position grow past it", async () => {
    const { call } = await setup({ env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2" } });
    await call("place_order", { ...order, side: "sell", size: 2 }); // short 2
    for (let k = 0; k < 4; k++) expect((await call("place_order", { ...order, type: "limit", limitPrice: 19990 })).data.success).toBe(true);
    expect((await call("modify_order", { accountId: 1, orderId: 2, size: 2 })).text).toMatch(/net position to 3/);
  });

  it("refuses orders outside the replay window", async () => {
    const before = await setup({ env: { BACKTESTER_START: iso(T0 + MIN) } });
    expect((await before.call("place_order", order)).text).toMatch(/Blocked by risk guardrail: .*before BACKTESTER_START/);
    const after = await setup({ env: { BACKTESTER_END: iso(T0 - MIN) } });
    expect((await after.call("place_order", order)).text).toMatch(/after BACKTESTER_END/);
    expect((await after.call("cancel_order", { accountId: 1, orderId: 1 })).text).toMatch(/after BACKTESTER_END/);
  });
});

describe("order management tools", () => {
  it("modify_order changes a stop and journals the reason", async () => {
    const { call, journal } = await setup();
    await call("place_order", { ...order, stopLossBracket: { ticks: 20, type: "stop" } });
    const res = await call("modify_order", { accountId: 1, orderId: 2, stopPrice: 20000.25, reason: "stop to breakeven" });
    expect(res.data).toEqual({ success: true, errorCode: 0, errorName: "Success", errorMessage: null });
    expect((await call("list_open_orders", { accountId: 1 })).data[0].stopPrice).toBe(20000.25);
    expect((await journal.read({ kind: "note" }))[0].text).toMatch(/breakeven/);
    expect((await call("modify_order", { accountId: 1, orderId: 2, size: 9 })).text).toMatch(/MAX_ORDER_SIZE/);
    expect((await call("modify_order", { accountId: 1, orderId: 99, stopPrice: 1 })).data).toMatchObject({ success: false, errorName: "OrderNotFound" });
  });

  it("cancel_order reports OrderNotFound", async () => {
    const { call } = await setup();
    expect((await call("cancel_order", { accountId: 1, orderId: 7 })).data).toMatchObject({ success: false, errorCode: 2, errorName: "OrderNotFound" });
  });

  it("close and partial close journal the exit", async () => {
    const { call, journal } = await setup();
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ", reason: "target hit" })).data).toMatchObject({ success: false, errorName: "PositionNotFound" });
    await call("place_order", order);
    expect((await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 3 })).data.errorName).toBe("InvalidCloseSize");
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    expect((await journal.read({ kind: "exit" })).map((e) => e.text)).toEqual(["target hit", "partial close 3", "close_position"]);
  });

  it("every write tool respects the account allow-list", async () => {
    const { call } = await setup({ env: { BACKTESTER_ALLOWED_ACCOUNT_IDS: "99" } });
    for (const [name, args] of [
      ["modify_order", { accountId: 1, orderId: 1 }],
      ["cancel_order", { accountId: 1, orderId: 1 }],
      ["close_position", { accountId: 1, contractId: "BT.MNQ" }],
      ["partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 1 }],
    ] as const) {
      expect((await call(name, args)).text).toMatch(/not in BACKTESTER_ALLOWED_ACCOUNT_IDS/);
    }
  });
});

describe("journal tools", () => {
  it("round-trips entries stamped with the replay time", async () => {
    const { call, setNow } = await setup();
    await call("journal_add", { kind: "lesson", text: "no trades in the first 5 minutes", tags: ["open"] });
    setNow(T0 + 7 * MIN);
    await call("journal_add", { kind: "plan", text: "trend day plan" });
    const { data } = await call("journal_read", { kind: "lesson" });
    expect(data).toEqual([{ ts: iso(T0), kind: "lesson", text: "no trades in the first 5 minutes", tags: ["open"] }]);
    expect((await call("journal_read", { since: iso(T0 + MIN) })).data.map((e: any) => e.text)).toEqual(["trend day plan"]);
  });
});

describe("bars across sessions", () => {
  it("aggregates hourly bars from 1-minute data", async () => {
    const { call } = await setup({ now: T0 + 60 * MIN, data: { NQ: seq(T0, Array.from({ length: 60 }, (_, i) => [100 + i, 101 + i, 99 + i, 100.5 + i])) } });
    expect((await call("get_bars", { contractId: "BT.NQ", unit: "hour", unitNumber: 1, limit: 5 })).data.bars).toEqual([
      { t: iso(T0), o: 100, h: 160, l: 99, c: 159.5, v: 600 },
    ]);
  });
});
