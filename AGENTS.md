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
- **Every position needs a protective stop.** Use `stopLossBracket` on the entry, or place a separate `stop` order on the opposite side once `list_open_positions` shows the fill.
- **Use micro contracts while learning:** MNQ, MES, MYM, M2K, MGC, SIL, MCL. Use size 1 until your journal shows positive expectancy over at least 30 closed trades.
- Never average down or widen a stop. You may tighten stops or move them to breakeven.
- Don't trade the first 5 minutes after 09:30 ET or through scheduled high-impact news unless the plan is built for it.
- After 2 losses in a row, stop and write a review before taking another trade.
- Close positions and cancel leftover working orders before the session ends. `close_position` doesn't cancel resting stop/target orders you placed yourself; check `list_open_orders` and cancel them.
- The trading day and daily loss limit reset at **17:00 America/Chicago** (18:00 ET).

### Replay details that cause mistakes

| Topic | What to know |
|---|---|
| Time | The replay clock is the only "now". Bars after it don't exist for you; orders fill only as the clock advances. |
| Market orders | Fill at the open of the next one-minute bar plus slippage (default 1 tick). When the clock sits exactly on a minute, that is the current bar's open, so the fill shows at once; otherwise the order waits in `list_open_orders` until the clock reaches the next minute. |
| Stops and targets | A stop fills at its price less slippage, or at the bar's open if the market gapped through it. A limit fills at its price or a better open. If one bar touches both your stop and your target, the stop fills. |
| Brackets | `stopLossBracket` / `takeProfitBracket` are in ticks from the entry fill and always work here (auto OCO). Check the legs with `list_open_orders`. When the position goes flat, its bracket legs are cancelled. |
| Sides | `buy` opens or adds to a long and closes a short. `sell` does the opposite. |
| Order types | `market`; `limit` needs `limitPrice`; `stop` needs `stopPrice`; `trailing_stop` needs `trailPrice` (an **absolute price level**, not a distance); `join_bid` / `join_ask` rest at the last price. |
| Modify / cancel | Take effect at once. A cancelled order never fills; a modified order is checked on its new terms for the whole bar in progress (up to 59 s before the modify) and after. |
| Status `rejected` | The broker refused the fill: it would have taken the position past the max, or opened exposure past the daily loss limit. `search_orders` shows `rejectReason`. Limits are checked at every fill, not only at placement. An order going through flat whose fill would breach the max position or the daily loss limit is rejected whole (within the limits it fills). A stop or target you placed yourself and left after a close can come back `rejected`, or fill as a new entry within the limits: cancel leftovers. |
| Order of fills | All opens of a minute before its closes; a contract's own fills keep their order (markets by arrival, stops before limits). Realized gains and losses on other contracts in the same minute count before an opening fill (pessimistic for losses, optimistic for gains). |
| `close_position` | Always taken; it means "flat after everything I sent before it": it fills in arrival order with your other waiting market orders and flattens whatever is open then. A close can stay visible as an open reduce-only order on a flat contract until the next bar (when something else flattened first); it then cancels itself, or flattens an entry you sent before it. A partial close while a close waits reduces what you sent after the close. An order placed before a close and modified after it still counts as sent before it. Sending it again is a no-op, unless you sent a market order after the waiting close: then the close moves after that order (the waiting one shows `cancelled`), so you still end flat. While a close waits, new orders are checked against the flat position it leaves: a sell "reducing" a long the close will remove is an opening order (limits and the daily loss apply). An order that only reduces gets no bracket legs. |
| Prices | Must be multiples of `tickSize` (MNQ/MES tick size is 0.25), or the order is rejected. |
| Bars | `get_bars` returns closed bars oldest→newest; `t` is the bar's open time in UTC. Units: minute, hour, day, week (built from one-minute data). |
| Fills | In `search_trades`, `profitAndLoss: null` (`halfTurn: true`) marks an opening fill. Realized P&L is on the closing fill. Fees are separate. |
| errorCode 5 `OutsideTradingHours` | The market is closed at the replay time (daily break, weekend, holiday, or past the data). Wait for the clock. |
| `before BACKTESTER_START` / `after BACKTESTER_END` | The clock is outside the replay window: orders that add risk are refused. Closes, cancels and exits still work; once no bar is left before the end they fill at the last close. |

### How to learn

The journal is where learning happens. Write entries that future-you can act on:

- **plan**: market context, setup name, entry trigger, invalidation, target, size, $ risk, and what would make you skip the trade.
- **review** (after every closed trade): what you planned vs. what you did, the result in R (P&L ÷ planned risk), whether the trade followed the plan, and the setup tag. Grade the process, not only the P&L.
- **lesson**: short rules that have evidence behind them. Tag lessons (`tags: ["setup:orb", "MNQ"]`) so `journal_read {tag}` finds them.

Journal entries are stamped with the replay time. `place_order` saves your `rationale` automatically, and blocked orders are journaled as `order_blocked`. Review these too.

### Tools

| Tool | Purpose |
|---|---|
| `get_server_config` | Whether trading is enabled, guardrail limits, trading-day start, the replay window, clock and data ranges |
| `list_accounts` | The simulated account, balance, `canTrade`, `mcpTradingAllowed` |
| `get_account_snapshot` | Balance, positions, working orders, today's P&L and remaining loss allowance |
| `search_contracts` / `get_contract` / `list_available_contracts` | Contract IDs (`BT.MNQ`), tick size, tick value |
| `get_bars` | Historical OHLCV bars up to the replay clock |
| `get_quote` | Last price as of the replay clock |
| `list_open_orders` / `search_orders` | Working orders / order history |
| `list_open_positions` | Open positions |
| `search_trades` / `get_performance` | Fills / statistics (win rate, expectancy, profit factor) |
| `place_order` / `modify_order` / `cancel_order` | Order entry and management |
| `close_position` / `partial_close_position` | Flatten or scale out at market |
| `journal_add` / `journal_read` | Long-term memory |

---

## For coding agents

Read [`CLAUDE.md`](CLAUDE.md): project, layout, commands, the rules for changes, and what to do before a pull request. It applies to every coding agent.

The short version: this repo holds **code only** (never commit market data); the tool contract stays identical to the harness's `docs/BROKER-MCP-INTERFACE.md` and to projectx-mcp's tools; the fill rules stay those of the harness's simulated broker (`scripts/lib/backtest/sim-broker.js`); every change comes with tests; and before every pull request `npm run typecheck`, `npm test`, `npm run build` and the harness's conformance check pass, and a reviewer other than the author has tried to break the change.
