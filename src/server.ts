import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ReplayError, specOf, type Outcome, type ReplayExchange } from "./client.js";
import { FLOW_WINDOW_MAX, FLOW_WINDOWS_MAX, publicConfig, type Config } from "./config.js";
import {
  BAR_UNITS,
  ORDER_TYPES,
  PLACEABLE_ORDER_TYPES,
  SIDES,
  decorateOrder,
  decoratePosition,
  decorateTrade,
} from "./enums.js";
import { JOURNAL_KINDS, Journal } from "./journal.js";
import { MIN_BRACKET_TICKS, bracketRefusal, pendingFill, positionOn, protectEntry, signedBrackets, type Protection } from "./protect.js";
import { snapPrices, snappedField } from "./ticks.js";
import { summarizeRoundTrips, summarizeTrades } from "./performance.js";
import {
  RiskError,
  assertDailyLoss,
  assertInWindow,
  assertOrderSize,
  assertPositionLimit,
  assertSymbolAllowed,
  assertTradingAllowed,
  opensExposure,
  type ExposureInput,
  realizedNet,
  tradingDayStart,
} from "./risk.js";

export interface Deps {
  config: Config;
  client: ReplayExchange;
  journal: Journal;
}

const INSTRUCTIONS = `Backtester / replay futures trading server. It implements the same broker interface as projectx-mcp (TopstepX), over local historical bars: the time is the replayed time (get_server_config.serverTime), and fills are simulated. Trade it exactly as you would a live account.
Workflow: get_server_config -> list_accounts -> search_contracts -> get_bars/get_quote -> journal_read (your past lessons) -> journal_add(kind "plan") -> place_order (with rationale) -> monitor via get_account_snapshot -> close/exit -> journal_add(kind "review" and "lesson").
Rules: always define the stop before entry; prefer micro contracts (MNQ, MES) while learning; never average down; flatten before the session closes unless the plan says otherwise; stop trading after hitting the daily loss limit.
Server-side guardrails (max order size, max position, daily loss, allowed accounts/symbols, the replay window) may refuse orders; respect them, do not try to work around them.
Read the resource backtester://guide for the full operating guide.`;

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

function describeError(e: unknown): string {
  if (e instanceof RiskError) return `Blocked by risk guardrail: ${e.message}`;
  if (e instanceof ReplayError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return json(await fn(args));
    } catch (e) {
      return failure(describeError(e));
    }
  };
}

const PLACE_ERRORS: Record<number, string> = {
  0: "Success", 1: "AccountNotFound", 2: "OrderRejected", 3: "InsufficientFunds", 4: "AccountViolation",
  5: "OutsideTradingHours", 6: "OrderPending", 7: "UnknownError", 8: "ContractNotFound", 9: "ContractNotActive",
  10: "AccountRejected",
};
const ORDER_EDIT_ERRORS: Record<number, string> = {
  0: "Success", 1: "AccountNotFound", 2: "OrderNotFound", 3: "Rejected", 4: "Pending", 5: "UnknownError", 6: "AccountRejected",
};
const CLOSE_ERRORS: Record<number, string> = {
  0: "Success", 1: "AccountNotFound", 2: "PositionNotFound", 3: "ContractNotFound", 4: "ContractNotActive",
  5: "InvalidCloseSize", 6: "OrderRejected (market closed/halted or no price)", 7: "OrderPending", 8: "UnknownError",
  9: "AccountRejected",
};

function outcome(res: Outcome, names: Record<number, string>) {
  return {
    success: res.success,
    errorCode: res.errorCode,
    errorName: names[res.errorCode] ?? `Unknown(${res.errorCode})`,
    errorMessage: res.errorMessage,
  };
}

const accountId = z.number().int().describe("Trading account ID from list_accounts.");
const contractId = z.string().min(1).describe('Contract ID, e.g. "BT.MNQ.M24" or "BT.MNQ". Get it from search_contracts.');
const isoTime = z.string().datetime({ offset: true });
const bracket = z
  .object({
    ticks: z
      .number()
      .int()
      .describe(`Distance from the entry fill, in ticks (at least ${MIN_BRACKET_TICKS}). The server signs it by side; the sign you send is ignored.`),
    type: z.enum(PLACEABLE_ORDER_TYPES).describe("Order type of the bracket leg, usually stop (for SL) or limit (for TP)."),
  })
  .optional();

export function createServer(deps: Deps): McpServer {
  const { config, client, journal } = deps;
  const server = new McpServer({ name: "backtester-mcp", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  // Local data and a simulated account: nothing reaches the outside world.
  const read = { readOnlyHint: true, openWorldHint: false } as const;
  const write = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

  const openPositions = async (acct: number) => client.positions(acct).map(decoratePosition);
  /** Open positions with their round trip so far (extra field `roundTrip`: MAE/MFE, bars held, initial risk). */
  const positionsWithMetrics = async (acct: number) => client.positions(acct, true).map(decoratePosition);
  const openOrders = async (acct: number) => client.openOrders(acct).map(decorateOrder);
  const trades = async (acct: number, start: string, end?: string) => client.trades(acct, start, end);
  const dayStart = () => tradingDayStart(client.now()).toISOString();
  /**
   * Net position and worst-case exposure of an order, as projectx-mcp would see it (there market
   * orders fill at once, as they do here unless no bar contains the moment or the run fills at the
   * next bar). The position counts market orders waiting for the next bar's open: all
   * of them when they add to it or go through flat, none when they only reduce it (so a
   * protective stop beside a waiting exit is still protective). Every resting same-side order
   * that could fill counts (limit, join, stop, trailing stop). Bracket legs and closes are
   * reduce-only and never count.
   */
  async function exposureOf(acct: number, cid: string, side: "buy" | "sell", size: number, except?: number) {
    const [positions, orders] = await Promise.all([openPositions(acct), openOrders(acct)]);
    const position = positions
      .filter((p) => p.contractId === cid)
      .reduce((n, p) => n + (p.type === 1 ? 1 : p.type === 2 ? -1 : 0) * (p.size as number), 0);
    let held = position;
    const mine = orders.filter((o) => o.id !== except && o.contractId === cid && !o.reduceOnly);
    // A waiting close_position leaves the contract flat: what counts is that, plus market orders
    // sent after it (an order "reducing" a position the close will remove is an opening order).
    const close = client.waitingClose(acct, cid);
    if (close !== null) held = 0;
    const waiting = mine
      .filter((o) => o.type === ORDER_TYPES.market && (close === null || (o.id as number) > close))
      .reduce((n, o) => n + (o.side === SIDES.buy ? 1 : -1) * (o.size as number), 0);
    const addsOrReverses = held === 0 || Math.sign(waiting) === Math.sign(held) || Math.abs(waiting) > Math.abs(held);
    const currentNet = addsOrReverses ? held + waiting : held;
    const resting: number[] = [ORDER_TYPES.limit, ORDER_TYPES.join_bid, ORDER_TYPES.join_ask, ORDER_TYPES.stop, ORDER_TYPES.trailing_stop];
    const pendingSameSide = mine
      .filter((o) => o.side === SIDES[side] && resting.includes(o.type as number))
      .reduce((n, o) => n + (o.size as number), 0);
    return { position, exposure: { currentNet, pendingSameSide, side, size } };
  }

  /**
   * An order that by itself only reduces the position (against it, no larger than it) is never
   * refused at placement, whatever else rests on its side: reducing is reducing. If, once it
   * fills, the position it meant to reduce is gone, the broker rejects that fill when it would
   * breach a limit (fill-time enforcement in client.ts).
   */
  const reducesAlone = (e: ExposureInput) => e.currentNet * (e.side === "buy" ? 1 : -1) < 0 && e.size <= Math.abs(e.currentNet);

  /** Adding exposure needs the replay window; protective and risk-reducing orders never do. */
  const addGuard = async (exposure: ExposureInput, acct: number) => {
    assertInWindow(config, client.now());
    if (config.maxDailyLoss > 0) assertDailyLoss(config, client.realizedToday(await trades(acct, dayStart())));
    assertPositionLimit(config, exposure);
  };

  const orderGuard = (acct: number) => assertTradingAllowed(config, acct);
  /** A journal write from an order tool: never fails the tool (as projectx-mcp's record). */
  const record = (entry: Parameters<Journal["add"]>[0]) => journal.add(entry).then(
    () => undefined,
    () => undefined,
  );

  // The data leaving a contract settles what was open on it, as close_position flattens: journaled
  // like a close_position (kind "exit", its flatten result), tagged roll_settlement. Appended in
  // order; journal_read waits for them.
  let journaling: Promise<unknown> = Promise.resolve();
  client.onRollSettlement = (e) => {
    const what = [
      e.closed ? `closed ${e.closed.size} at ${e.closed.price} (order ${e.closed.orderId})` : null,
      e.cancelled.length ? `cancelled orders ${e.cancelled.join(", ")}` : null,
    ].filter(Boolean);
    const text = `Roll settlement: the replay data left ${e.contractId} at ${e.at}; ${what.join("; ")}.`;
    journaling = journaling.then(() =>
      record({ kind: "exit", text, accountId: e.accountId, contractId: e.contractId, tags: ["roll_settlement"], data: { ...e.result, rollSettlement: true, at: e.at } }),
    );
  };

  type OrderType = (typeof PLACEABLE_ORDER_TYPES)[number];
  interface PlaceArgs {
    accountId: number;
    contractId: string;
    side: "buy" | "sell";
    type: OrderType;
    size: number;
    limitPrice?: number;
    stopPrice?: number;
    trailPrice?: number;
    stopLossBracket?: { ticks: number; type: OrderType };
    takeProfitBracket?: { ticks: number; type: OrderType };
    customTag?: string;
    rationale: string;
  }

  /**
   * place_order as projectx-mcp's placeOrder: bracket distances checked before anything is sent,
   * guardrails, the canTrade refusal of opening orders, prices rounded onto the tick grid, signed
   * brackets, and for a bracketed market entry that opens, the protection check.
   */
  async function placeOrder(a: PlaceArgs) {
    if (a.type === "limit" && a.limitPrice === undefined) throw new RiskError("limit orders require limitPrice.");
    if (a.type === "stop" && a.stopPrice === undefined) throw new RiskError("stop orders require stopPrice.");
    if (a.type === "trailing_stop" && a.trailPrice === undefined) throw new RiskError("trailing_stop orders require trailPrice.");
    for (const [label, b] of [["stopLossBracket", a.stopLossBracket], ["takeProfitBracket", a.takeProfitBracket]] as const) {
      const why = b ? bracketRefusal(label, b.ticks) : null;
      if (why) throw new RiskError(why);
    }

    orderGuard(a.accountId);
    assertSymbolAllowed(config, a.contractId);
    assertOrderSize(config, a.size);

    const before = positionOn(await openPositions(a.accountId), a.contractId);
    const { exposure } = await exposureOf(a.accountId, a.contractId, a.side, a.size);
    // Opening = anything but an exit no larger than the position; reversals open.
    const opening = opensExposure(exposure) && !reducesAlone(exposure);
    if (opening) {
      const account = client.accounts().find((x) => x.id === a.accountId);
      if (account?.canTrade === false) {
        const msg = `Blocked by risk guardrail: account ${account.name} has canTrade=false (locked by the firm); only orders that reduce a position are allowed.`;
        await record({ kind: "order_blocked", text: `${msg} | rationale: ${a.rationale}`, accountId: a.accountId, contractId: a.contractId });
        return { ...json({ orderId: null, success: false, errorCode: 4, errorName: PLACE_ERRORS[4], errorMessage: msg }), isError: true };
      }
      await addGuard(exposure, a.accountId);
    }

    const protect = a.type === "market" && !!a.stopLossBracket && opening;
    const signed = signedBrackets(a.side, a.stopLossBracket?.ticks, a.takeProfitBracket?.ticks);
    const snap = snapPrices({ limitPrice: a.limitPrice, stopPrice: a.stopPrice, trailPrice: a.trailPrice }, a.side, specOf(a.contractId)?.tickSize ?? null);
    const res = client.place({
      accountId: a.accountId,
      contractId: a.contractId,
      type: ORDER_TYPES[a.type],
      side: SIDES[a.side],
      size: a.size,
      limitPrice: snap.prices.limitPrice ?? null,
      stopPrice: snap.prices.stopPrice ?? null,
      trailPrice: snap.prices.trailPrice ?? null,
      customTag: a.customTag || null,
      stopLossBracket: a.stopLossBracket ? { ticks: signed.stop as number, type: ORDER_TYPES[a.stopLossBracket.type] } : null,
      takeProfitBracket: a.takeProfitBracket ? { ticks: signed.target as number, type: ORDER_TYPES[a.takeProfitBracket.type] } : null,
    });
    let result: Record<string, unknown> = { orderId: res.orderId, customTag: res.customTag, ...outcome(res, PLACE_ERRORS), ...snappedField(snap.snapped) };

    let protection: Protection | undefined;
    if (res.success && res.orderId != null && protect) {
      const orderId = res.orderId;
      protection = await protectEntry(
        {
          order: () => client.order(a.accountId, orderId),
          position: () => positionOn(client.positions(a.accountId), a.contractId),
          ordersOn: () => client.openOrders(a.accountId).filter((o) => o.contractId === a.contractId),
          cancelEntry: () => client.cancel(a.accountId, orderId).success,
          flatten: () => client.flatten(a.accountId, a.contractId),
          note: (text, data) => record({ kind: "note", text, accountId: a.accountId, contractId: a.contractId, orderId, tags: ["protection"], data }),
        },
        { contractId: a.contractId, side: a.side, orderId, before, targetRequested: !!a.takeProfitBracket },
      );
    } else if (res.success && a.stopLossBracket && opening && a.type !== "market") {
      protection = pendingFill(!!a.takeProfitBracket);
    }
    if (protection) result = { ...result, protection };
    // Nothing was opened: not an entry, so not success (the orderId stays for the record).
    if (protection?.status === "not_filled") {
      result = { ...result, success: false, errorCode: 2, errorName: PLACE_ERRORS[2], errorMessage: protection.message };
    }
    // The caller reads errorMessage on an error reply; an unverified flatten must say a position may be open.
    if (protection?.status === "unknown") result.errorMessage = protection.message;

    const request = { side: a.side, type: a.type, size: a.size, limitPrice: a.limitPrice, stopPrice: a.stopPrice, trailPrice: a.trailPrice, stopLossBracket: a.stopLossBracket, takeProfitBracket: a.takeProfitBracket };
    await record({
      kind: "order_placed",
      text: a.rationale,
      accountId: a.accountId,
      contractId: a.contractId,
      orderId: res.orderId ?? undefined,
      data: { request, result, positionBefore: before.net, sizeBefore: before.size },
    });
    const isError = !result.success || protection?.status === "unknown";
    return isError ? { ...json(result), isError: true } : json(result);
  }

  // ── Session / config ────────────────────────────────────────────────

  server.registerTool(
    "get_server_config",
    {
      title: "Server config and guardrails",
      description:
        "Show whether trading is enabled and the risk guardrails this server enforces (max order size, max position, daily loss limit, allowed accounts/symbols), plus the replay: window, clock, the data range per symbol, and dataGaps (per root, the window's trading days without order-book data: {day, bars, flow: false}; bars true: served from the price CSV, no order flow; bars false: no bars at all, skipped). Call this first in every session.",
      annotations: read,
    },
    handler(async () => {
      const now = client.now();
      const pub = publicConfig(config);
      return {
        ...pub,
        clock: { ...pub.clock, now: now.toISOString() },
        data: client.dataRanges(),
        dataStore: client.storeInfo(),
        dataGaps: client.dataGaps(),
        tradingDayStartedAt: tradingDayStart(now).toISOString(),
        serverTime: now.toISOString(),
      };
    }),
  );

  // ── Accounts ────────────────────────────────────────────────────────

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description: "List trading accounts on this login with balance and canTrade flag. The replay has one simulated account.",
      inputSchema: { onlyActiveAccounts: z.boolean().default(true) },
      annotations: read,
    },
    handler(async (_a: { onlyActiveAccounts: boolean }) =>
      client.accounts().map((a) => ({
        ...a,
        mcpTradingAllowed: config.tradingEnabled && (!config.allowedAccountIds.length || config.allowedAccountIds.includes(a.id)),
      })),
    ),
  );

  server.registerTool(
    "get_account_snapshot",
    {
      title: "Account snapshot",
      description:
        "One-call view of an account: balance, open positions, working orders, and today's realized P&L (trading day starts 17:00 America/Chicago) versus the daily loss limit. Use this to monitor between decisions.",
      inputSchema: { accountId },
      annotations: read,
    },
    handler(async ({ accountId: acct }: { accountId: number }) => {
      const start = dayStart();
      const [accounts, positions, orders, today] = await Promise.all([client.accounts(), positionsWithMetrics(acct), openOrders(acct), trades(acct, start)]);
      // Today's P&L with what the balance schedule carried into the day (replay only; balance.ts).
      const realized = client.realizedToday(today);
      return {
        account: accounts.find((a) => a.id === acct) ?? null,
        positions,
        openOrders: orders,
        today: {
          tradingDayStartedAt: start,
          realizedNetPnL: Math.round(realized * 100) / 100,
          dailyLossLimit: config.maxDailyLoss || null,
          remainingBeforeLimit: config.maxDailyLoss ? Math.round((config.maxDailyLoss + realized) * 100) / 100 : null,
          ...summarizeTrades(today).overall,
        },
      };
    }),
  );

  // ── Market data ─────────────────────────────────────────────────────

  server.registerTool(
    "search_contracts",
    {
      title: "Search contracts",
      description:
        'Find tradable contracts by text, e.g. "MNQ", "ES", "GC". Returns up to 20 with id, tickSize, tickValue (USD per tick per contract) and activeContract. Trade the activeContract=true front month.',
      inputSchema: {
        searchText: z.string().min(1),
        live: z.boolean().default(false).describe("Use the live data subscription instead of sim. Ignored in replay."),
      },
      annotations: read,
    },
    handler(async ({ searchText }: { searchText: string; live: boolean }) => client.searchContracts(searchText)),
  );

  server.registerTool(
    "get_contract",
    {
      title: "Get contract",
      description: "Look up one contract by ID (tick size, tick value, whether it is the active month).",
      inputSchema: { contractId },
      annotations: read,
    },
    handler(async ({ contractId: id }: { contractId: string }) => client.contract(id)),
  );

  server.registerTool(
    "list_available_contracts",
    {
      title: "List available contracts",
      description: "List every contract available to trade (every contract whose data file is in BACKTESTER_DATA_DIR).",
      inputSchema: { live: z.boolean().default(false) },
      annotations: read,
    },
    handler(async (_a: { live: boolean }) => client.allContracts()),
  );

  server.registerTool(
    "get_bars",
    {
      title: "Historical bars",
      description:
        "OHLCV bars for a contract, returned oldest→newest. t=bar open time (UTC), o/h/l/c=prices, v=volume. " +
        "Defaults: endTime=now (the replay clock), startTime chosen to cover `limit` bars. Max 20,000 bars. " +
        "Only bars closed by the replay clock (unless includePartialBar); built from 1-minute data, so units are minute, hour, day, week. " +
        "includeOrderFlow=true (default: this server's configuration, see get_server_config flow.barsOrderFlow) adds `flow` to each minute or hour bar: bv, sv, delta, trades, volume, vwap, ofiTrade, ofiQuote, imbalance, largeBuy, largeSell, complete, " +
        "and `windows` (ofiTrade and delta over the last n bar spans for each n in flowWindows), summed from per-minute order flow of the local order-book history " +
        "(aggressor sides inferred from the quote, then the tick rule; exchange times). Every value is null unless all the bar's minutes are complete. " +
        "MNQ bars carry NQ's flow (same contract month); other contracts and the CSV series carry none.",
      inputSchema: {
        contractId,
        unit: z.enum(Object.keys(BAR_UNITS) as [keyof typeof BAR_UNITS]).default("minute"),
        unitNumber: z.number().int().positive().default(5).describe("Bar size in units, e.g. unit=minute unitNumber=5 → 5-minute bars."),
        limit: z.number().int().positive().max(20000).default(100),
        startTime: isoTime.optional(),
        endTime: isoTime.optional(),
        includePartialBar: z.boolean().default(false),
        live: z.boolean().default(false),
        includeOrderFlow: z.boolean().optional().describe("Add per-bar order flow (minute and hour bars). Default: the server's BACKTESTER_BARS_ORDER_FLOW (false unless set)."),
        flowWindows: z.array(z.number().int().min(1).max(FLOW_WINDOW_MAX)).max(FLOW_WINDOWS_MAX).optional().describe("With includeOrderFlow: window sizes in bars, e.g. [5]. Default: the server's BACKTESTER_BARS_FLOW_WINDOWS (none unless set)."),
      },
      annotations: read,
    },
    handler(async (a: {
      contractId: string;
      unit: keyof typeof BAR_UNITS;
      unitNumber: number;
      limit: number;
      startTime?: string;
      endTime?: string;
      includePartialBar: boolean;
      live: boolean;
      includeOrderFlow?: boolean;
      flowWindows?: number[];
    }) => {
      const base = (count: number) => ({ contractId: a.contractId, barSize: `${a.unitNumber} ${a.unit}`, count });
      // Arguments the call leaves out take the server's configured defaults; explicit ones always win.
      const includeOrderFlow = a.includeOrderFlow ?? config.barsOrderFlow;
      const flowWindows = a.flowWindows ?? config.barsFlowWindows;
      if (!includeOrderFlow) {
        const bars = client.bars(a);
        return { ...base(bars.length), bars };
      }
      const windows = [...new Set(flowWindows)].sort((x, y) => x - y);
      const res = client.barsWithFlow(a, windows);
      return { ...base(res.bars.length), ...res };
    }),
  );

  server.registerTool(
    "get_quote",
    {
      title: "Live quote",
      description:
        "Latest quote as of the replay clock (lastPrice = the last closed 1-minute bar's close; bestBid = bestAsk = lastPrice; session open/high/low, volume). Returns null quote when the market is closed (no bar in the last 15 minutes).",
      inputSchema: { contractId, timeoutMs: z.number().int().min(500).max(15000).default(5000) },
      annotations: read,
    },
    handler(async ({ contractId: id }: { contractId: string; timeoutMs: number }) => {
      const hit = client.quote(id);
      return hit
        ? { contractId: id, ageMs: hit.ageMs, quote: hit.quote }
        : { contractId: id, quote: null, note: "No quote received. The market may be closed; use get_bars for the last prices." };
    }),
  );

  // ── Orders, positions, trades (read) ────────────────────────────────

  server.registerTool(
    "list_open_orders",
    {
      title: "Open orders",
      description: "Working orders on an account (includes bracket stop/target legs, and market orders waiting for the next bar's open: only when no bar contains the moment, or in a next-bar run).",
      inputSchema: { accountId },
      annotations: read,
    },
    handler(async ({ accountId: acct }: { accountId: number }) => openOrders(acct)),
  );

  server.registerTool(
    "search_orders",
    {
      title: "Order history",
      description: "Orders created in a time window (any status). For trailing stops, trailPrice here is the trail distance in price, not a level.",
      inputSchema: { accountId, startTimestamp: isoTime, endTimestamp: isoTime.optional() },
      annotations: read,
    },
    handler(async (a: { accountId: number; startTimestamp: string; endTimestamp?: string }) =>
      client.searchOrders(a.accountId, a.startTimestamp, a.endTimestamp ?? null).map(decorateOrder),
    ),
  );

  server.registerTool(
    "list_open_positions",
    {
      title: "Open positions",
      description:
        "Open positions on an account. direction is long/short; averagePrice is the entry. roundTrip (extra) is the trade so far: MAE/MFE in points, ticks, $ and R over the closed bars, bars held, initial stop and risk.",
      inputSchema: { accountId },
      annotations: read,
    },
    handler(async ({ accountId: acct }: { accountId: number }) => positionsWithMetrics(acct)),
  );

  server.registerTool(
    "search_trades",
    {
      title: "Fill history",
      description:
        "Fills in a time window. profitAndLoss is null on the opening half of a round turn (halfTurn=true) and set on the closing fill. Defaults to the current trading day. Extra fields: roundTripId (the round trip the fill belongs to), exitReason on a reducing fill (partial, stop, trail, target, close, end), and roundTrip on the fill that ended a round trip (entry/exit, MAE/MFE in points, ticks, $ and R, bars held, gross/fees/net, R).",
      inputSchema: { accountId, startTimestamp: isoTime.optional(), endTimestamp: isoTime.optional() },
      annotations: read,
    },
    handler(async (a: { accountId: number; startTimestamp?: string; endTimestamp?: string }) =>
      client.tradeReport(a.accountId, a.startTimestamp ?? dayStart(), a.endTimestamp).trades.map((t) => decorateTrade(t as unknown as Record<string, unknown>)),
    ),
  );

  server.registerTool(
    "get_performance",
    {
      title: "Performance statistics",
      description:
        "Win rate, net P&L after fees, average win/loss, profit factor, expectancy, overall and per contract, for a time window (default: current trading day). roundTrips (extra) grades whole trades ending in the window: win rate, average win/loss and expectancy in $ and R, profit factor, max drawdown, MAE/MFE of winners vs losers, bars held. Use it to grade your own trading.",
      inputSchema: { accountId, startTimestamp: isoTime.optional(), endTimestamp: isoTime.optional() },
      annotations: read,
    },
    handler(async (a: { accountId: number; startTimestamp?: string; endTimestamp?: string }) => {
      const start = a.startTimestamp ?? dayStart();
      const report = client.tradeReport(a.accountId, start, a.endTimestamp);
      return { window: { start, end: a.endTimestamp ?? "now" }, ...summarizeTrades(report.trades), roundTrips: summarizeRoundTrips(report.roundTrips) };
    }),
  );

  // ── Trading (write) ─────────────────────────────────────────────────

  server.registerTool(
    "place_order",
    {
      title: "Place order",
      description:
        "Submit an order. side: buy|sell. type: market | limit (needs limitPrice) | stop (needs stopPrice) | trailing_stop (needs trailPrice = absolute price level, NOT a distance) | join_bid | join_ask. " +
        `Brackets (stopLossBracket/takeProfitBracket) are distances in ticks (at least ${MIN_BRACKET_TICKS}); the server signs them by side. The replay account always takes them (auto OCO). ` +
        "After a market entry with a stopLossBracket the server checks the fill and the stop leg; " +
        "if it cannot, it closes the position (see `protection.status` in the result). " +
        "Market orders fill at once, at the replay moment, at the open of the 1-minute bar containing it plus slippage (a run with BACKTESTER_MARKET_FILL=next-bar: at the next bar's open). " +
        "Off-grid prices are rounded onto the tick grid away from the market (stops: sell down, buy up; limits: buy down, sell up) and reported in `snapped`. " +
        "Server guardrails may block the order. `rationale` is required and saved to the journal so you can learn from the outcome.",
      inputSchema: {
        accountId,
        contractId,
        side: z.enum(["buy", "sell"]),
        type: z.enum(PLACEABLE_ORDER_TYPES),
        size: z.number().int().positive(),
        limitPrice: z.number().positive().optional(),
        stopPrice: z.number().positive().optional(),
        trailPrice: z.number().positive().optional(),
        stopLossBracket: bracket,
        takeProfitBracket: bracket,
        customTag: z.string().max(100).optional().describe("Must be unique across the account."),
        rationale: z
          .string()
          .min(20)
          .describe("Why this trade: setup, invalidation (where the stop is and why), target, and expected risk in $."),
      },
      annotations: write,
    },
    async (a: PlaceArgs) => {
      try {
        return await placeOrder(a);
      } catch (e) {
        if (e instanceof RiskError) {
          await record({ kind: "order_blocked", text: `${e.message} | rationale: ${a.rationale}`, accountId: a.accountId, contractId: a.contractId });
        }
        return failure(describeError(e));
      }
    },
  );

  server.registerTool(
    "modify_order",
    {
      title: "Modify order",
      description:
        "Change size or price of a working order (e.g. move a stop to breakeven). trailPrice is an absolute price level; unlike place_order there is no max-distance check, so double-check it. " +
        "Off-grid limitPrice/stopPrice are rounded onto the tick grid by the working order's side, as in place_order (a stop-limit's limit rounds with its stop), and reported in `snapped`; trailPrice is passed through unchanged.",
      inputSchema: {
        accountId,
        orderId: z.number().int(),
        size: z.number().int().positive().optional(),
        limitPrice: z.number().positive().optional(),
        stopPrice: z.number().positive().optional(),
        trailPrice: z.number().positive().optional(),
        reason: z.string().optional().describe("Why; saved to the journal."),
      },
      annotations: write,
    },
    handler(async (a: { accountId: number; orderId: number; size?: number; limitPrice?: number; stopPrice?: number; trailPrice?: number; reason?: string }) => {
      orderGuard(a.accountId);
      if (a.size !== undefined) assertOrderSize(config, a.size);
      // No side or contract in the input: read the working order. If it cannot be read, the prices go
      // unchanged (as projectx-mcp); a size increase then fails closed (noGrowth below), a cut is taken.
      let lookupError: unknown = null;
      const working = await openOrders(a.accountId).catch((e: unknown) => {
        lookupError = e;
        return [];
      });
      const o = working.find((x) => x.id === a.orderId);
      if (a.size !== undefined) {
        // A bigger resting order is more exposure: the same position and daily loss checks as place_order.
        if (o && !o.reduceOnly && a.size > (o.size as number)) {
          const side = o.side === SIDES.buy ? "buy" : "sell";
          const { exposure } = await exposureOf(a.accountId, o.contractId as string, side, a.size, a.orderId);
          // Protective growth (orders against the position staying within it) never increases exposure.
          if (opensExposure(exposure) && !reducesAlone(exposure)) await addGuard(exposure, a.accountId);
        }
      }
      const prices = { limitPrice: a.limitPrice, stopPrice: a.stopPrice, trailPrice: a.trailPrice };
      let snap: ReturnType<typeof snapPrices> = { prices, snapped: {} };
      const side = o?.side === SIDES.buy ? "buy" : o?.side === SIDES.sell ? "sell" : null;
      // trailPrice is never rounded here (projectx-mcp: a working trailing stop may read it back as a distance).
      if ((a.limitPrice !== undefined || a.stopPrice !== undefined) && side) {
        const tick = specOf(o!.contractId as string)?.tickSize ?? null;
        snap = snapPrices(prices, side, tick, { stopLimit: o!.type === ORDER_TYPES.stop_limit, fields: ["limitPrice", "stopPrice"] });
      }
      const res = client.modify({
        accountId: a.accountId,
        orderId: a.orderId,
        size: a.size ?? null,
        limitPrice: snap.prices.limitPrice ?? null,
        stopPrice: snap.prices.stopPrice ?? null,
        trailPrice: snap.prices.trailPrice ?? null,
        // Unread working orders: the exchange refuses a size increase and takes a cut (fail closed).
        noGrowth: a.size !== undefined && lookupError !== null,
      });
      const snappedNote = Object.keys(snap.snapped).length ? ` (snapped to tick: ${JSON.stringify(snap.snapped)})` : "";
      if (a.reason || snappedNote) {
        await record({
          kind: "note",
          text: `modify order ${a.orderId}: ${a.reason ?? "price change"}${snappedNote}`,
          accountId: a.accountId,
          orderId: a.orderId,
          ...(snappedNote ? { tags: ["tick-snap"], data: { snapped: snap.snapped } } : {}),
        });
      }
      return { ...outcome(res, ORDER_EDIT_ERRORS), ...snappedField(snap.snapped) };
    }),
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel order",
      description: "Cancel a working order.",
      inputSchema: { accountId, orderId: z.number().int() },
      annotations: write,
    },
    handler(async (a: { accountId: number; orderId: number }) => {
      orderGuard(a.accountId);
      return outcome(client.cancel(a.accountId, a.orderId), ORDER_EDIT_ERRORS);
    }),
  );

  server.registerTool(
    "close_position",
    {
      title: "Close position",
      description:
        "Flatten the whole position in a contract at market, then cancel every working order on that contract (stop/target legs and any other orders), then verify. " +
        'status: "flat" (no position, no working orders), "still_open" (the position is still there or could not be read; its orders are left in place so it keeps its stop) or ' +
        '"legs_left" (flat, but working orders remain or could not be read). The last two are errors: check list_open_positions and list_open_orders.',
      inputSchema: { accountId, contractId, reason: z.string().optional().describe("Why; saved to the journal.") },
      annotations: write,
    },
    async (a: { accountId: number; contractId: string; reason?: string }) => {
      try {
        orderGuard(a.accountId);
        const fl = client.flatten(a.accountId, a.contractId);
        const result = {
          status: fl.status,
          success: fl.status === "flat",
          close: outcome(fl.close as Outcome, CLOSE_ERRORS),
          positionNet: fl.positionNet,
          positionSize: fl.positionSize,
          cancelledOrderIds: fl.cancelledOrderIds,
          remainingOrderIds: fl.remainingOrderIds,
        };
        await record({ kind: "exit", text: a.reason ?? "close_position", accountId: a.accountId, contractId: a.contractId, data: result });
        return fl.status === "flat" ? json(result) : { ...json(result), isError: true };
      } catch (e) {
        return failure(describeError(e));
      }
    },
  );

  server.registerTool(
    "partial_close_position",
    {
      title: "Partially close position",
      description: "Close part of a position at market (scale out).",
      inputSchema: { accountId, contractId, size: z.number().int().positive(), reason: z.string().optional() },
      annotations: write,
    },
    handler(async (a: { accountId: number; contractId: string; size: number; reason?: string }) => {
      orderGuard(a.accountId);
      const res = client.close(a.accountId, a.contractId, a.size);
      await record({ kind: "exit", text: a.reason ?? `partial close ${a.size}`, accountId: a.accountId, contractId: a.contractId, data: outcome(res, CLOSE_ERRORS) });
      return outcome(res, CLOSE_ERRORS);
    }),
  );

  // ── Learning journal ────────────────────────────────────────────────

  server.registerTool(
    "journal_add",
    {
      title: "Write to trading journal",
      description:
        "Persist your reasoning so future sessions can learn from it. kinds: plan (pre-session thesis), entry, exit, review (post-trade grading: what happened vs. plan), lesson (a durable rule you want future-you to follow), note.",
      inputSchema: {
        kind: z.enum(["plan", "entry", "exit", "review", "lesson", "note"]),
        text: z.string().min(1),
        accountId: accountId.optional(),
        contractId: contractId.optional(),
        orderId: z.number().int().optional(),
        tags: z.array(z.string()).optional().describe('Free-form, e.g. ["breakout", "MNQ", "mistake:chased"].'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handler(async (a: { kind: (typeof JOURNAL_KINDS)[number]; text: string; accountId?: number; contractId?: string; orderId?: number; tags?: string[] }) =>
      journal.add(a),
    ),
  );

  server.registerTool(
    "journal_read",
    {
      title: "Read trading journal",
      description:
        'Read past journal entries (newest last). Start each session with journal_read({kind:"lesson"}) and recent reviews so you do not repeat mistakes.',
      inputSchema: {
        kind: z.enum(JOURNAL_KINDS).optional(),
        tag: z.string().optional(),
        contractId: contractId.optional(),
        since: isoTime.optional(),
        limit: z.number().int().positive().max(500).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async (q: { kind?: (typeof JOURNAL_KINDS)[number]; tag?: string; contractId?: string; since?: string; limit: number }) => {
      await journaling;
      return journal.read(q);
    }),
  );

  // ── Guide resource & session prompt ─────────────────────────────────

  const guideUrl = new URL("../AGENTS.md", import.meta.url);
  server.registerResource(
    "guide",
    "backtester://guide",
    { title: "Trading agent operating guide", description: "How to use these tools to trade and learn.", mimeType: "text/markdown" },
    async (uri) => {
      let text: string;
      try {
        text = readFileSync(guideUrl, "utf8");
      } catch {
        /* c8 ignore next */
        text = INSTRUCTIONS;
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );

  server.registerPrompt(
    "trading_session",
    {
      title: "Start a trading session",
      description: "Kick off a disciplined trading session: review lessons, plan, trade within guardrails, review.",
      argsSchema: { focus: z.string().optional().describe("Contract or setup to focus on, e.g. MNQ opening range.") },
    },
    ({ focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Run a trading session${focus ? ` focused on ${focus}` : ""}. Read backtester://guide first. ` +
              "Then: get_server_config; list_accounts; journal_read lessons and recent reviews; build a written plan (journal_add kind=plan) " +
              "with setup, entry trigger, stop, target, size, and max $ risk; only then trade. After each exit write a review, and end the session with at least one lesson.",
          },
        },
      ],
    }),
  );

  return server;
}
