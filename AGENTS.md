# AGENTS.md

This file has two readers:

1. **The trading agent**: a reasoning model (Claude, ChatGPT, …) connected to this MCP server and trading its simulated account. The server also serves this file as the MCP resource `backtester://guide`.
2. **Coding agents** changing this repository (Codex, Qwen Code, Claude Code, others). Read [`CLAUDE.md`](CLAUDE.md); it applies to every coding agent. See [For coding agents](#for-coding-agents) at the end.

---

## For the trading agent

This server is a **replay broker**. It answers with the same tools, inputs and results as a live broker MCP server (projectx-mcp for TopstepX), but the market is historical: the time is the replayed time, and fills are simulated from one-minute bars. Trade it exactly as you would trade a live account, because that's what it rehearses. Your job has two parts: **trade with discipline**, and **get better over time** by writing down what you did and what you learned, then reading it back.

### What you can't see without asking

- You have no memory between conversations except the **journal** (`journal_read` / `journal_add`). Read it at the start of every session.
- You don't know the current time, price, or position until you call a tool. The time is the **replay clock** (`get_server_config.serverTime`), not today's date. Never assume. Re-check with `get_account_snapshot` before every decision.
- The server enforces guardrails that you can't change. When an order is blocked, the error begins with `Blocked by risk guardrail:`. Accept it. Don't retry with smaller sizes split across orders, other accounts, or other symbols to get around it.

### Session loop

```
1. get_server_config            → is trading enabled? what are the limits? the replay window and clock
2. list_accounts                → pick an account with canTrade=true and mcpTradingAllowed=true
3. journal_read {kind:"lesson"} → your standing rules. Also read the last few "review" entries.
4. get_account_snapshot         → balance, open positions, working orders, today's P&L vs. the loss limit
5. search_contracts "MNQ"       → take the activeContract=true id. Note tickSize and tickValue.
6. get_bars (+ get_quote)       → read the market on more than one timeframe
7. journal_add {kind:"plan"}    → thesis, setup, entry trigger, stop, target, size, $ risk
8. place_order (with rationale) → only if the plan's trigger has actually happened
9. monitor: get_account_snapshot / get_quote → manage by the plan (move stop, scale out, exit)
10. after exit: get_performance + journal_add {kind:"review"}
11. end of session: journal_add {kind:"lesson"} → at most 1–3 short, concrete rules
```

### Risk rules (follow these even when the server would allow more)

- **Decide the stop before you enter.** Risk per trade = |entry − stop| / tickSize × tickValue × size. Keep it ≤ 25% of the remaining daily loss allowance (`remainingBeforeLimit` in the snapshot).
- **Every position needs a protective stop at the broker.** Enter with a `stopLossBracket`: the server checks the fill and the stop leg and closes the position if it can't (see [What `place_order` and `close_position` return](#what-place_order-and-close_position-return)). The replay account always takes brackets. A separate `stop` order on the opposite side is only for repairing protection (a position whose stop is missing or too small), never the way to enter.
- **Use micro contracts while learning:** MNQ, MES, MYM, M2K, MGC, SIL, MCL. Use size 1 until your journal shows positive expectancy over at least 30 closed trades.
- Never average down or widen a stop. You may tighten stops or move them to breakeven.
- Don't trade the first 5 minutes after 09:30 ET or through scheduled high-impact news unless the plan is built for it.
- After 2 losses in a row, stop and write a review before taking another trade.
- Close positions before the session ends. `close_position` closes the position, then cancels every working order on that contract (stop/target legs and any other order there) and checks the result. After a partial close or an exit by your own order, check `list_open_orders` and cancel leftovers.
- The trading day and daily loss limit reset at **17:00 America/Chicago** (18:00 ET).

### Replay details that cause mistakes

| Topic | What to know |
|---|---|
| Time | The replay clock is the only "now". Bars after it don't exist for you; resting orders fill only as the clock advances. |
| Market orders | Fill at once, as live: at the moment you send them, at the price the one-minute bar in progress opened at (no tool shows it yet: quotes and bars show closed bars) plus slippage (default 1 tick) against you, stamped with the replay time. Check the fill right away with `list_open_positions` / `search_trades`. Only when no bar trades in that minute does the order wait in `list_open_orders` for the next bar's open. (A run started with `BACKTESTER_MARKET_FILL=next-bar` fills them at the next minute's open instead; `get_server_config.marketFill` says which.) `join_bid` / `join_ask` fill at once too when the price they join is marketable. |
| Stops and targets | A stop fills at its price less slippage, or at the bar's open if the market gapped through it. A limit fills at its price or a better open. If one bar touches both your stop and your target, the stop fills. |
| Brackets | `stopLossBracket` / `takeProfitBracket` `ticks` are **distances** from the entry fill (at least 4 ticks); the server signs them by side, so send `10`, not `-10`: the stop always goes on the loss side, the target on the profit side. They always work here (auto OCO). Check the legs with `list_open_orders`. They are checked from the first one-minute bar that opens at or after the fill: the rest of the minute you entered in is not checked (a fill exactly on a minute is checked on that minute), and a next bar opening through your stop fills it at that open. When the position goes flat, its bracket legs are cancelled. |
| Sides | `buy` opens or adds to a long and closes a short. `sell` does the opposite. |
| Order types | `market`; `limit` needs `limitPrice`; `stop` needs `stopPrice`; `trailing_stop` needs `trailPrice` (an **absolute price level**, not a distance); `join_bid` / `join_ask` rest at the last price. |
| Modify / cancel | Take effect at once. A cancelled order never fills; a modified order is checked on its new terms for the whole bar in progress (up to 59 s before the modify) and after. |
| Status `rejected` | The broker refused the fill: it would have taken the position past the max, or opened exposure past the daily loss limit. `search_orders` shows `rejectReason`. Limits are checked at every fill, not only at placement. An order going through flat whose fill would breach the max position or the daily loss limit is rejected whole (within the limits it fills). A stop or target you placed yourself and left after a close can come back `rejected`, or fill as a new entry within the limits: cancel leftovers. |
| Order of fills | All opens of a minute before its closes; a contract's own fills keep their order (markets by arrival, stops before limits). Realized gains and losses on other contracts in the same minute count before an opening fill at a bar's open or close (pessimistic for losses, optimistic for gains). A market order you send during a minute fills at that moment, before that minute's stops and targets settle at its close: a stop another contract hits in that minute doesn't block it. |
| `close_position` | Returns `status` (below). Always taken, and fills at once like any market order; once the contract is flat it cancels every working order on it. It means "flat after everything I sent before it". When market orders wait (no bar this minute, or a `next-bar` run) the reply is `still_open` and the orders stay until the close fills (when it leaves the contract flat, it then cancels the orders that were working when you sent it, not ones sent after); the close fills in arrival order with your other waiting market orders and flattens whatever is open then. A close can stay visible as an open reduce-only order on a flat contract until the next bar (when something else flattened first); it then cancels itself, or flattens an entry you sent before it. A partial close while a close waits reduces what you sent after the close. An order placed before a close and modified after it still counts as sent before it. Sending it again is a no-op, unless you sent a market order after the waiting close: then the close moves after that order (the waiting one shows `cancelled`), so you still end flat. While a close waits, new orders are checked against the flat position it leaves: a sell "reducing" a long the close will remove is an opening order (limits and the daily loss apply). An order that only reduces gets no bracket legs. |
| Prices | Must be multiples of `tickSize` (MNQ/MES tick size is 0.25, MGC 0.1). The server rounds off-grid prices onto the grid, never toward the market or to a worse fill, and reports it in `snapped` (see below). Send on-grid prices anyway: the rounding is a safety net. |
| `canTrade=false` / errorCode 4 `AccountViolation` | The account's balance is gone (the replay's "locked" account). Opening orders are refused; reducing orders still go through. Stop trading it. |
| Bars | `get_bars` returns closed bars oldest→newest; `t` is the bar's open time in UTC. Units: minute, hour, day, week (built from one-minute data). A minute with no trades has no bar. |
| Contracts and rolls | For NQ and MNQ the replay may serve one contract per expiry (`BT.MNQ.M24`, raw prices, no back-adjustment): take the `activeContract=true` id from `search_contracts` each session. The front changes at 18:00 ET at the start of the trading day in which the data rolls; the new front has no bars until 00:00 ET (about 6 hours), and orders that would open a position on it are refused until then, while the old month still has its bars. Lookback on the new front is short on roll days. A contract has bars only while the data was on it: the next contract has none before its roll, and the old one's stop at the roll (for lookback across a roll, read the old id too). When the data leaves a contract for good, a position on it is closed at its last close and its working orders are cancelled (fills and orders show `rollSettlement: true`, round-trip reason `roll`, and the journal gets a `roll_settlement` note): live, the old month would trade on; here it has no more bars. If the data is away from a contract for a day, nothing fills on its bars then; a close or a reducing market order fills at its last close, a protective stop is taken, and only orders that add exposure are refused. Past the replay's data, as after the replay window, only orders that reduce a position are taken. Elsewhere ids are `BT.MNQ`, one back-adjusted series. |
| Fills | In `search_trades`, `profitAndLoss: null` (`halfTurn: true`) marks an opening fill. Realized P&L is on the closing fill. Fees are separate. |
| errorCode 5 `OutsideTradingHours` | The market is closed at the replay time (daily break, weekend, holiday, or past the data). Wait for the clock. |
| `before BACKTESTER_START` / `after BACKTESTER_END` | The clock is outside the replay window: orders that add risk are refused. Closes, cancels and exits still work; once no bar is left before the end they fill at the last close (in the last whole minute before the end, market orders still fill at once as usual). |

### Tick rounding (`snapped`)

`place_order` and `modify_order` round each price onto the contract's tick grid, exactly as the live server does:

| Price | buy | sell |
|---|---|---|
| `stopPrice`, `trailPrice` (stop, trailing_stop) | up | down |
| `limitPrice` | down (never pay more) | up |
| `limitPrice` of a working stop-limit (`modify_order`) | up, like its stop | down, like its stop |

So a long's protective sell stop at 20999.9 goes to 20999.75 and a short's buy stop at 21000.1 to 21000.25; a buy limit at 21000.1 goes to 21000.00.

- `modify_order` takes the side and type from the working order. It **never rounds `trailPrice`**: it goes to the broker exactly as you send it (here an off-grid one is refused, `Rejected`).
- When a price changed, the result has `snapped: { stopPrice: { from: 20999.9, to: 20999.75 } }` (one entry per changed field), and the journal records it. Recompute your $ risk from the `to` price.

### What `place_order` and `close_position` return

An order **reduces** only when it is on the opposite side of the open position and no larger than it (long 2, sell 1 or 2). Everything else **opens**: a new position, an add, and a reversal through flat (long 1, sell 2).

After a **market** entry with a `stopLossBracket` that opens, the server checks the fill and that working stops cover the whole new position, on the side opposite that position (for a reversal, the new side). It never places a stop of its own. If the entry hasn't filled when the server answers (no trade in this minute, or a `next-bar` run: it would wait for the next bar), the server cancels it. If anything opened without a covering stop, it closes the **whole** position on that contract, including any part that was open before this entry, and cancels every order there. `protection.status` in the result says what happened:

| `protection.status` | Meaning | What you do |
|---|---|---|
| `protected` | Filled, and the bracket's stop is working (`stopOrderId`). | Manage the trade by the plan. |
| `flattened_stop_unconfirmed` | Filled, but no covering stop (an add to a position without its own stop, or a stop-loss leg that isn't a stop type), so the server closed the position, cancelled the orders on that contract, and confirmed flat. | Treat it as a closed trade and review it. Don't re-send the entry. |
| `pending_fill` | A resting (limit/stop) entry; its bracket legs attach when it fills. | Check `list_open_positions` and `list_open_orders` later. Don't re-send. |
| `not_filled` | The market entry ended without a fill (rejected at fill, or cancelled by the server because it didn't fill when sent). The reply is an error: `success: false`, `errorCode: 2` (`OrderRejected`), an `errorMessage` that says which, and the `orderId` for the record. | Nothing was opened, and a position you already had is untouched. Wait for the clock before trying again. |
| `unknown` | The stop wasn't confirmed and the flatten couldn't be confirmed either. The reply is an error whose message starts with `UNPROTECTED POSITION MAY BE OPEN`. | Call `close_position` for the contract now, then check `list_open_positions` and `list_open_orders`. Never re-send the entry. |

`filledSize`, `fillPrice`, `stopOrderId` and `targetPlaced` sit next to the status. Every `place_order` result has the order's `customTag` (yours, or one the server made). Other things to know:

- A bracket under 4 ticks is refused before anything is sent: `Blocked by risk guardrail: stopLossBracket is 3 ticks; the minimum bracket distance is 4 ticks.`
- An account with `canTrade=false` refuses opening orders (`errorCode` 4, `AccountViolation`, journaled as `order_blocked`). Reducing orders go through.
- `close_position` returns `status`: `flat` (no position, no working orders on the contract), `still_open` (the position is still there: the close waits for the next bar or was refused; its orders are left in place so it keeps its stop) or `legs_left` (flat, but some orders couldn't be cancelled). The last two are errors: look at `list_open_positions` and `list_open_orders` and finish the job. `close` inside it is the close request's own outcome (on a contract already flat it is `PositionNotFound`, and the call still ends `flat`).
- Every order tool answers at once here (the live server answers within 10 seconds).

### Trade metrics: grade whole trades

The server groups your fills into **round trips**: from the fill that takes a contract's position away from flat to the fill that brings it back to flat (or reverses it; a reversal ends one round trip and starts the next). Adds and partial exits belong to the same round trip. All of it is computed only from bars closed by the replay clock.

- `search_trades`: every fill has `roundTripId`; a fill that reduced the position has `exitReason` (`partial`, or the round trip's reason); the fill that ended a round trip carries `roundTrip`.
- `list_open_positions` / `get_account_snapshot`: each position has `roundTrip`, the trade so far (MAE/MFE, bars held, initial stop and risk).
- `get_performance`: `roundTrips.overall` / `byContract` grade the round trips that ended in the window.

| Field | Meaning |
|---|---|
| `reason` | `stop` (a stop not moved during the trade), `trail` (trailing stop, a stop you moved with `modify_order` during the trade, or a stop you cancelled and replaced at another price after the first minute), `target` (take-profit leg or limit order), `close` (close/partial close/market order), `end` (closed after the replay window), `other` |
| `initialStop`, `riskDollars` | The stop that protected the trade from the start: its stop-loss bracket, or the closest stop on the closing side working at the entry or placed within a minute after it. Risk $ = \|entry − stop\| ÷ tickSize × tickValue × entry size. No such stop: every R field is `null`, so attach the stop at once to get graded in R. |
| `r`, `rNet` | Gross P&L ÷ risk $, net P&L ÷ risk $ |
| `maeDollars` / `maeR` / `maeTicks` / `maePoints` / `maeTime` | Worst point of the trade's running P&L (realized so far + open), ≤ 0, starting at 0 at entry |
| `mfeDollars` / `mfeR` / … / `mfeTime` | Best point of the same, ≥ 0 |
| `barsHeld` | One-minute bars the trade was open from open to close |
| `gross`, `fees`, `net`, `partialExits`, `reversed` | P&L of the whole round trip; scale-outs; whether it ended by reversing |

Excursions use the high and low of each closed bar held whole, plus every fill price. On a bar where a fill happened inside the bar (a stop, target, limit/stop entry, or a market order sent during the minute), only that bar's open (when you held the position into the bar) and the fill price count, because whether its high or low came before the fill is unknown. Ticks and points are per contract open at that moment.

Aggregates: `winRate`, `avgWin` / `avgLoss` / `expectancy` ($, net), `avgWinR` / `avgLossR` / `expectancyR` (net R, trades with a stop only, counted in `tradesWithR`), `profitFactor`, `maxDrawdown` (realized equity curve, $), `avgMaeRWinners` / `avgMfeRWinners` / `avgMaeRLosers` / `avgMfeRLosers`, `winnersPastMinus1R` (share of winners that were down a full R first), `avgBarsHeld`. A win is `net > 0`.

Use them in reviews: a winner with `maeR` near −1 was nearly stopped (entry timing); a loser with high `mfeR` gave back a winner (exit or target placement); `reason: "trail"` on a loss means a moved stop failed.

### How to learn

The journal is where learning happens. Write entries that future-you can act on:

- **plan**: market context, setup name, entry trigger, invalidation, target, size, $ risk, and what would make you skip the trade.
- **review** (after every closed trade): what you planned vs. what you did, the result in R (P&L ÷ planned risk; the closing fill's `roundTrip` has `r`, `maeR`, `mfeR`), whether the trade followed the plan, and the setup tag. Grade the process, not only the P&L.
- **lesson**: short rules that have evidence behind them. Tag lessons (`tags: ["setup:orb", "MNQ"]`) so `journal_read {tag}` finds them.

Journal entries are stamped with the replay time. `place_order` saves your `rationale` automatically, and blocked orders are journaled as `order_blocked`. Review these too.

### Tools

| Tool | Purpose |
|---|---|
| `get_server_config` | Whether trading is enabled, guardrail limits, trading-day start, the replay window, clock and data ranges |
| `list_accounts` | The simulated account, balance, `canTrade`, `mcpTradingAllowed` |
| `get_account_snapshot` | Balance, positions (with `roundTrip`), working orders, today's P&L and remaining loss allowance |
| `search_contracts` / `get_contract` / `list_available_contracts` | Contract IDs (`BT.MNQ.M24` or `BT.MNQ`), tick size, tick value |
| `get_bars` | Historical OHLCV bars up to the replay clock |
| `get_quote` | Last price as of the replay clock |
| `list_open_orders` / `search_orders` | Working orders / order history |
| `list_open_positions` | Open positions, each with its trade so far (`roundTrip`) |
| `search_trades` / `get_performance` | Fills with round-trip metrics / statistics (win rate, expectancy, profit factor; `roundTrips`: $ and R, drawdown, MAE/MFE) |
| `place_order` / `modify_order` / `cancel_order` | Order entry and management |
| `close_position` / `partial_close_position` | Flatten or scale out at market |
| `journal_add` / `journal_read` | Long-term memory |

---

## For coding agents

Read [`CLAUDE.md`](CLAUDE.md): project, layout, commands, the rules for changes, and what to do before a pull request. It applies to every coding agent.

The short version: this repo holds **code only** (never commit market data, the derived store or its manifests); the tool contract stays identical to the harness's `docs/BROKER-MCP-INTERFACE.md` and to projectx-mcp's tools; the fill rules stay those of the harness's simulated broker (`scripts/lib/backtest/sim-broker.js`); every change comes with tests; and before every pull request `npm run typecheck`, `npm test`, `npm run build` and the harness's conformance check pass, and a reviewer other than the author has tried to break the change.

The local NQ order-book data (L1/L2 parquet) reaches the server only through the derived store (`npm run build-store`, see the README): `calendar.ts` (ET days, Globex hours, the quarterly roll rule), `parquet.ts` (one row group at a time), `events.ts` (normalized events and bars from trades), `rolltable.ts` and `rolltable-nq.ts` (the reviewed roll table, the only source of which contract the data is on; derived with `scripts/derive-roll-table.ts`, a dev tool), `store.ts` (layout, reader, events), `storebuild.ts` and the CLI `build-store.ts`. Tests write tiny synthetic parquet into temp folders (`test/orderbook.ts`); never point a test at the real data, and never write into the source folder.
