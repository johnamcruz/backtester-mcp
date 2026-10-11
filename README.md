# backtester-mcp

**A replay broker: an MCP server that implements the futures-trading-harness broker interface over local historical bars, with a replay clock and simulated fills.**

It answers with the same tools, inputs, results and errors as [projectx-mcp](https://github.com/johnamcruz/projectx-mcp) (TopstepX), so it is a drop-in replacement at the level of the [broker MCP interface](https://github.com/johnamcruz/futures-trading-harness/blob/main/docs/BROKER-MCP-INTERFACE.md): same tool names, input schemas and result shapes, plus a few extra result fields. Only three things are simulated: the **data** (your one-minute CSVs), the **clock** (a file the replay driver advances), and the **fills** (the rules of the harness backtester's simulated broker). Use it to backtest a harness end to end, or to replay a day the way it would have traded live.

> [!NOTE]
> This repository holds code only. It ships no market data: bring your own, keep it outside the repo, and point `BACKTESTER_DATA_DIR` at it. Market data is usually licensed by its vendor or exchange; don't commit or redistribute it. Run state, journals and clock files stay out of the repo too (`.gitignore` covers them).

## What the model gets

| Area | Tools |
|---|---|
| Session | `get_server_config`: trading enabled, the guardrails, `serverTime` (the replay clock), `replay: true`, the replay window, clock and data range per symbol, run and fill settings |
| Accounts | `list_accounts`, `get_account_snapshot` (balance, positions with their trade so far, working orders, today's P&L vs. the loss limit) |
| Market data | `search_contracts`, `get_contract`, `list_available_contracts`, `get_bars` (closed bars up to the replay clock), `get_quote` (last close) |
| Trading | `place_order` (market, limit, stop, trailing stop, join bid/ask, with stop-loss/take-profit brackets), `modify_order`, `cancel_order`, `close_position`, `partial_close_position` |
| History | `list_open_orders`, `search_orders`, `list_open_positions`, `search_trades` (fills, with [trade metrics](#trade-metrics) on closing fills) |
| Learning | `get_performance` (per-fill statistics plus round-trip grading), `journal_add`, `journal_read` |

These are the same 20 tools as projectx-mcp, with the same input fields, defaults and result shapes. The server also serves an operating guide (the MCP resource `backtester://guide`, the first half of [AGENTS.md](AGENTS.md)), MCP server instructions, and a `trading_session` prompt.

## Setup

Requires Node.js 20.12 or later.

```bash
git clone https://github.com/johnamcruz/backtester-mcp && cd backtester-mcp
npm install
npm run build          # tsc -> dist/
cp .env.example .env   # then set BACKTESTER_DATA_DIR and a clock
```

`node dist/index.js` serves MCP over stdio; `node dist/index.js --http` (or `MCP_TRANSPORT=http`) serves Streamable HTTP at `/mcp`, which requires `MCP_HTTP_AUTH_TOKEN`, as in projectx-mcp. The server writes only MCP messages to stdout; it logs to stderr.

### Data

`BACKTESTER_DATA_DIR` is a folder of one-minute files, one per root:

```text
<data>/NQ_1min.csv   ES_1min.csv   YM_1min.csv   RTY_1min.csv   GC_1min.csv   SI_1min.csv   CL_1min.csv
```

```csv
datetime,open,high,low,close,volume
2024-03-05 15:00:00+00:00,20466.0,20495.75,20464.5,20490.75,6162.0
```

- Timestamps are UTC (`YYYY-MM-DD HH:MM:SS+00:00` or ISO with `Z`) and mark the bar's **open**; rows are oldest first (a duplicate timestamp keeps the first row). Each file is one back-adjusted continuous series.
- Micros replay their mini's file at the micro's tick value: MNQ→`NQ_1min.csv`, MES→ES, MYM→YM, M2K→RTY, MGC→GC, SIL→SI, MCL→CL.
- Only the one-minute file is read; `get_bars` builds every other bar size from it.
- A file is loaded once per process, when first needed, before the run's lock is taken.

| Contract | Tick | $/tick | Data file | | Contract | Tick | $/tick | Data file |
|---|---|---|---|---|---|---|---|---|
| MNQ | 0.25 | 0.50 | NQ | | NQ | 0.25 | 5.00 | NQ |
| MES | 0.25 | 1.25 | ES | | ES | 0.25 | 12.50 | ES |
| MYM | 1 | 0.50 | YM | | YM | 1 | 5.00 | YM |
| M2K | 0.1 | 0.50 | RTY | | RTY | 0.1 | 5.00 | RTY |
| MGC | 0.1 | 1.00 | GC | | GC | 0.1 | 10.00 | GC |
| SIL | 0.005 | 5.00 | SI | | SI | 0.005 | 25.00 | SI |
| MCL | 0.01 | 1.00 | CL | | CL | 0.01 | 10.00 | CL |

Contracts are listed only when their file exists. Ids are `BT.<ROOT>` (one continuous series per root); `name` is the front-month ticker at the replay time (`MNQH24`), which is what the harness's contract translator reads.

### Configuration

Every option is in [.env.example](.env.example). Settings come from the environment (an MCP client's `env` block, or the variables a harness forwards) or a `.env` file in the working directory (`BACKTESTER_ENV_FILE` names another).

| Variable | Default | Meaning |
|---|---|---|
| `BACKTESTER_DATA_DIR` | required | Folder of `<ROOT>_1min.csv` files |
| `BACKTESTER_CLOCK_FILE` | | Replay clock file, `{ "now": "<ISO>" }`, re-read on every call |
| `BACKTESTER_NOW` | | Fixed replay time when there is no clock file (one of the two is required) |
| `BACKTESTER_START` / `BACKTESTER_END` | none | The replay window (ISO, UTC); `END` must be after `START` |
| `BACKTESTER_RUN_ID` | `default` | Names the run (letters, digits, `.`, `_`, `-`) |
| `BACKTESTER_STATE_DIR` | `~/.backtester-mcp/runs/<run id>` | The run's folder: `state.json` (account, orders, fills), its lock, and the default journal |
| `BACKTESTER_ACCOUNT_ID` / `BACKTESTER_ACCOUNT_NAME` | `1` / `BACKTEST-<run id>` | The simulated account |
| `BACKTESTER_START_BALANCE` | `100000` | Starting balance |
| `BACKTESTER_SLIPPAGE_TICKS` | `1` | Ticks of slippage per market and stop fill |
| `BACKTESTER_FEES_MICRO` / `BACKTESTER_FEES_MINI` | `0.37` / `1.40` | Fees per side per contract |
| `BACKTESTER_MARKET_FILL` | `now` | When market orders fill (see [Fills](#fills)): `now` at the replay moment they are placed, as live; `next-bar` at the next one-minute bar's open (the rule before this setting; runs created then keep it) |
| `BACKTESTER_JOURNAL_PATH` | `<state dir>/journal.jsonl` | The journal (same JSONL format as projectx-mcp's; the harness's order gate reads it) |
| `BACKTESTER_TRADING_ENABLED` | `false` | Order tools are refused unless `true` |
| `BACKTESTER_ALLOWED_ACCOUNT_IDS` / `BACKTESTER_ALLOWED_SYMBOLS` | any | Comma-separated; symbols are roots (`MNQ,MES`) |
| `BACKTESTER_MAX_ORDER_SIZE` / `BACKTESTER_MAX_POSITION_SIZE` | `1` / `2` | See [Guardrails](#guardrails-the-model-cannot-override) |
| `BACKTESTER_MAX_DAILY_LOSS` | `500` | `0` turns it off |
| `BACKTESTER_ENV_FILE` | `.env` | Another file to load settings from |
| `MCP_TRANSPORT`, `PORT`, `HOST`, `MCP_HTTP_AUTH_TOKEN` | stdio, `8787`, `127.0.0.1` | HTTP mode (`--http` or `MCP_TRANSPORT=http`); the token (16+ characters) is required there |

## The replay clock

The server's "now" is the replayed time, never the wall clock. It reads `BACKTESTER_CLOCK_FILE` on every call, falling back to `BACKTESTER_NOW`, and reports it as `get_server_config.serverTime`. A replay driver writes the file and moves it forward; the server reacts on the next call:

- **On every call**, before answering, the run is synced to the clock: every one-minute bar between the last synced time and now is processed in order. A bar's **open** fills market orders waiting for it (only when no bar contained the moment they were placed, or in a `next-bar` run: by default a market order fills when it is placed); its **close** (once `t + 1 min <= now`) settles resting orders against its high and low.
- `get_bars` and `get_quote` see only bars closed by now (capped at `BACKTESTER_END`). `includePartialBar: true` adds the bucket still forming, built from closed one-minute bars only.
- The clock may only move forward within a run. A clock earlier than the run's synced time is an error: start a new run instead.
- Results depend only on the data, the window, the clock sequence and the orders: the same inputs give the same fills. Nothing in fills, state or journal timestamps uses the wall clock, and nothing is random.

Drive the clock by hand with the clock CLI:

```bash
node dist/clock.js --file /tmp/clock.json --set 2024-03-05T14:30:00Z
node dist/clock.js --file /tmp/clock.json --step 1        # one minute
node dist/clock.js --file /tmp/clock.json --next-bar 5    # to the next 5-minute close
node dist/clock.js --file /tmp/clock.json                 # print it
```

### The replay window

`BACKTESTER_START` and `BACKTESTER_END` bound a run. Bars before `START` stay available to `get_bars` as lookback history; after `END`, `get_bars` is capped at `END` and nothing fills on later bars. While the clock is before `START` or after `END`, orders that add exposure answer `Blocked by risk guardrail: …`; closes, cancels and risk-reducing orders are still taken. Once no bar is left to fill on before `END` (the clock is at or past `END`, or the next bar opens after it), `close_position`, `partial_close_position` and market orders that reduce the position fill at the last close at or before the clock (and `END`), without slippage, as the harness backtester settles a trade still open at the end of its data (reason `end`); other orders are refused with `OutsideTradingHours`.

Orders are also refused (`OutsideTradingHours`) when the market is closed at the replay time: the next one-minute bar after now falls in a later trading day (the daily break, weekends, holidays) or there is no data after now.

### Runs, isolation and the lock

All mutable state lives in the run's folder (`BACKTESTER_STATE_DIR`, by default `~/.backtester-mcp/runs/<BACKTESTER_RUN_ID>`): `state.json` and, unless `BACKTESTER_JOURNAL_PATH` says otherwise, `journal.jsonl`. Every process started with the same folder shares the run (the harness starts the server more than once: its gateway and its runner). Each call is one transaction: take the lock file (`state.json.lock`), read the clock and the state, sync, act, write atomically (write and rename), release. A lock older than 30 seconds is treated as left by a crashed process and removed; a caller gives up after 60 seconds. A run records its account and fill settings (account id, start balance, slippage, fees, the market fill rule) when it is created and refuses a process configured differently. A run created before the market fill rule was recorded filled market orders at the next bar's open, so it keeps `next-bar`: continue it with `BACKTESTER_MARKET_FILL=next-bar` (a process with the default `now` is refused with that hint), or start a new run. Give parallel replays different run ids or folders. To replay again from the start, use a new run id or delete the folder.

## Guardrails the model cannot override

The same checks and semantics as projectx-mcp's, with `BACKTESTER_` names:

| Setting | Default | Effect |
|---|---|---|
| `BACKTESTER_TRADING_ENABLED` | `false` | Order tools are refused unless this is `true`. Read-only tools always work. |
| `BACKTESTER_ALLOWED_ACCOUNT_IDS` | any | Only these accounts can be traded. |
| `BACKTESTER_ALLOWED_SYMBOLS` | any | Contract roots, e.g. `MNQ,MES` (ids are `BT.<ROOT>`). |
| `BACKTESTER_MAX_ORDER_SIZE` | `1` | Maximum contracts per order. |
| `BACKTESTER_MAX_POSITION_SIZE` | `2` | Maximum absolute net position per contract, counting every resting same-side order that could fill (limit, join, stop and trailing stop) and market orders waiting for the next bar when they add to the position or go through flat (bracket legs and closes never count), also when `modify_order` grows a resting order. An order is checked (position and daily loss) when it opens exposure: the worst case ends further from flat, or the order itself goes through flat. Pure reduction and protective orders (a stop and a target covering the position) are always allowed. |
| `BACKTESTER_MAX_DAILY_LOSS` | `500` | Once realized P&L after fees for the trading day (from 17:00 CT / 18:00 ET, replay time) reaches −this amount, only orders that reduce the position are allowed. `0` turns it off. |
| `BACKTESTER_START` / `BACKTESTER_END` | none | Orders that add exposure are refused while the replay clock is outside the window. |

Refusals read `Blocked by risk guardrail: …` and are journaled as `order_blocked`, as with projectx-mcp.

**Limits at fill time.** The max position and the daily loss limit are also enforced when an order fills, as a broker enforces server-side limits: a close, a bracket leg or a reducing market order can flatten the position first, and an opposite order accepted earlier would then fill as a new entry. Before any fill of a client order, the server checks the position the fill would leave. A fill that opens exposure (grows the position or goes through flat) past `BACKTESTER_MAX_POSITION_SIZE`, or while the daily loss limit is reached, is rejected whole: the order gets status `rejected` (5) with a `rejectReason` in `search_orders` (an extra field), and nothing fills, not even the reducing half of an order going through flat. Reducing fills, bracket legs and closes are never rejected. Fills are checked one at a time against the position the fills before them left. At placement, an order that by itself only reduces the position is never refused, whatever rests beside it.

A stop or target you placed yourself (not a bracket leg) and left resting after the position closed is your own order: when it triggers it fills as a new entry if that stays within the limits, or comes back `rejected` if it would breach one. Cancel leftovers after a close.

## Fills

The fill engine (`src/fills.ts`) is ported from the harness's simulated broker, [`scripts/lib/backtest/sim-broker.js`](https://github.com/johnamcruz/futures-trading-harness/blob/main/scripts/lib/backtest/sim-broker.js) (the fill model the harness backtester's `engine.js` drives), cited by function in the code, so a replay fills the way a backtest does. One timing rule is the replay's own, because replay must behave like the live market: a market order sent inside a minute fills at that moment (a live market order fills within seconds), where the sim-broker, which only orders at bar boundaries, has no such case. At a bar boundary both fill at that bar's open plus slippage.

| Order | Fill |
|---|---|
| Market (entries, `close_position`, `partial_close_position`) | At once, at the replay moment it is placed, as a live market order fills within seconds: the open of the one-minute bar containing that moment (the last price known then) plus `BACKTESTER_SLIPPAGE_TICKS` in the order's direction, stamped at the moment. Nothing after the moment is read: not that bar's high, low or close, nor later bars. When the moment is a bar's open this is the harness backtester's fill exactly. If no bar contains the moment (no trade in that minute), the order waits in `list_open_orders` for the next bar's open, the next price there is. With `BACKTESTER_MARKET_FILL=next-bar`: always the next bar opening at or after the moment (at once only when the clock sits exactly on a bar's open). In the session's last minute a market order fills (the bar contains the moment); other orders need a next bar in the same trading day. |
| `join_bid` / `join_ask` on arrival | Join the last close. When that price is marketable at the open of the bar containing the moment (a buy at or above it, a sell at or below it) they fill at once at the limit or the better open, without slippage, stamped at the moment; otherwise they rest as limits. |
| Stop (`stop`, stop-loss legs, trailing stops) | The stop price less slippage; if the bar opens through the stop, the bar's open less slippage. |
| Limit (`limit`, take-profit legs, `join_bid`/`join_ask`) | The limit price, or a better open. No slippage. Touch fills. |
| Stop and target touched in one bar | The stop fills (the conservative reading). |
| Brackets | Legs sit `ticks` from the entry's fill price (slippage included). A market entry's legs are checked from the first bar opening at or after the fill: on its fill bar when it filled at that bar's open; from the next bar when it filled inside a bar (the rest of that bar is not checked: its high or low may have come before the fill, and the part after it is unknown, so it is left out rather than guessed; a next bar that opens through a leg fills it at that open, gap rule). A filled leg cancels its sibling (OCO); all bracket legs are cancelled when the position is flat or reverses, and a leg never opens a position. An order that only reduces the position gets no legs; one that goes through flat gets legs for the new part. |
| Limit or stop entries filled inside a bar | Their stop-loss leg is checked on the same bar too (pessimistic: the stop is assumed hit after the entry), at its own price less slippage; the take-profit leg from the next bar. Fills inside a bar are stamped at the bar's close. |
| Orders placed inside a bar | Checked from the next bar that opens at or after that moment (no look-back). Resting orders already working through that bar settle at its close, after a market fill made inside it (whether the bar's high or low came before the moment is unknown, and reading them at the moment would look ahead). |
| Modify / cancel | Take effect at once, as at a live broker (and the sim-broker's `cancel()`): a cancelled order never fills; a modified order is checked on its new terms from the bar in progress on (a bar is settled only once it closes, so the new terms apply to that whole minute, up to 59 seconds before the modify). A waiting market order can't be modified; cancel it. |
| Trailing stop | Placed at `trailPrice` (an absolute level); after each bar the stop follows the bar's extreme at the original distance, never loosening. The harness runner trails with `modify_order` instead. |
| P&L and fees | Ticks × tick value × size; fees per side per contract on every fill. Daily P&L resets at 17:00 CT (18:00 ET). |

**`close_position` and partial closes.** By default a close fills when it is sent (above), so it waits only when no bar contains the moment or in a `next-bar` run; the rules below are for a waiting close. `close_position` is always taken and means "flat after everything sent before it". It fills in arrival order with the contract's other waiting market orders and flattens whatever is open when it fills, so the position ends flat even with an add waiting beside it. If something else flattens the position first, the close stays visible as an open reduce-only order on a flat contract until its bar: it then flattens an entry sent before it that reopened the position, or cancels itself. Sending it again while one waits is a no-op (success, nothing added), unless a client market order arrived after the waiting close: then the close moves after that order (the waiting one shows `cancelled`). While a close waits, new orders are checked at placement against the flat position it will leave (a sell "reducing" a long the close will remove is an opening order: limits and the daily loss apply). Arrival is when an order was placed: one placed before a close and modified after it still counts as sent before it. `partial_close_position` never closes more than is open; while a `close_position` waits it reduces what was sent after the close, and with nothing sent after it answers `OrderPending`. Closes are never cancelled by other fills: each closes what it can when it fills and cancels itself otherwise. Orders that only reduce (closes, bracket legs) carry `reduceOnly: true` (an extra field) in order results.

**Order of fills.** A market order (or marketable join) filled when it is placed fills at that moment, after every bar event up to it. Each one-minute bar has two moments: its open (waiting market orders fill) and its close (resting orders settle against its range). All opens of a minute come before any of its closes. Within a contract the order never changes: market orders by arrival, resting orders stops first, then by order id. Across contracts, each moment runs in two passes: first every contract's fills up to (not including) its first fill that would open exposure, then the rest of every contract in the same order. So realized gains and losses at a moment on other contracts count before an opening fill: since the order inside a minute is unknown, this is pessimistic for losses (a same-minute loss can block an entry) and optimistic for gains (a same-minute gain can lift a daily-loss block).

## Trade metrics

Fills are grouped into **round trips** (`src/metrics.ts`), computed from the run's whole fill history and the one-minute bars, deterministic and without lookahead: only bars closed at or before the clock (capped at `BACKTESTER_END`) are read.

**Round trip.** A position episode on one contract: it opens with the fill that takes the net position away from flat (or the part of a fill beyond flat when it reverses), includes every add and partial exit, and ends with the fill that returns the position to flat or reverses it. A reversing fill ends one round trip and opens the next. Its `id` is the id of its opening fill.

**Where they appear** (extra fields only; no existing field or input changes):

| Tool | Extra fields |
|---|---|
| `search_trades` | Every fill: `roundTripId`. A fill that reduced the position: `exitReason` (`partial` when the round trip goes on, else the round trip's reason). The fill that ended a round trip: `roundTrip` (the object below). A reversing fill's `roundTripId` is the round trip it ended; the next one's id is that fill's own `id`. |
| `get_performance` | `roundTrips: { overall, byContract }`: the round trips that ended in the window (complete even if they began before it) |
| `list_open_positions`, `get_account_snapshot` | Each position: `roundTrip`, the trade so far (`open: true`; exit fields, `reason`, `r` and `rNet` null; `gross`, `fees`, `net` realized so far) |

**Per round trip** (`roundTrip`):

| Field | Definition |
|---|---|
| `direction`, `entryTime`, `entryPrice`, `entrySize` | The opening fill (its part beyond flat for a reversal) |
| `averageEntryPrice`, `maxSize`, `closedSize` | Size-weighted average of all opening and adding fills; largest open size; contracts closed |
| `exitTime`, `exitPrice`, `exitFillId` | The ending fill's time and id; size-weighted average price of all closing fills |
| `reason` | From the ending fill's order: `stop` (a stop-loss leg or client stop not moved during the trade), `trail` (a trailing stop; a stop moved with `modify_order` during the trade; or, once you cancelled or moved the initial stop's order (with `cancel_order` / `modify_order`, before the exit), a client stop placed after the trade's first minute at another price: a cancel-and-replace move; other stops, such as a scale-out stop or an add's stop, read `stop`, also when the engine cancelled a bracket leg by OCO), `target` (a take-profit leg, or a limit or `join_bid`/`join_ask` order, whatever the P&L), `close` (`close_position`, `partial_close_position` or a market order), `end` (filled at the last close after `BACKTESTER_END`), `other` |
| `partialExits`, `reversed` | Closing fills that did not end it; whether it ended by going through flat |
| `initialStop`, `risk`, `riskDollars` | The initial stop (below); `risk` = \|entryPrice − initialStop\| in price; `riskDollars` = risk ÷ tickSize × tickValue × entrySize. All null without an initial stop |
| `maePoints`, `maeTicks`, `maeDollars`, `maeR`, `maeTime` | Maximum adverse excursion (≤ 0) |
| `mfePoints`, `mfeTicks`, `mfeDollars`, `mfeR`, `mfeTime` | Maximum favourable excursion (≥ 0) |
| `barsHeld` | One-minute bars the round trip was open from the bar's open to its close |
| `gross`, `fees`, `net` | Sum of the closing fills' `profitAndLoss`; fees of all its fills (a reversing fill's fees split by size); gross − fees |
| `r`, `rNet` | gross ÷ riskDollars (the harness's `r`) and net ÷ riskDollars; null without an initial stop |

Dollars are rounded to cents, R to 0.001 (as the harness rounds it).

**Excursions.** The round trip's running P&L at a price x is *realized so far + sign × (x − average entry) × tickValue ÷ tickSize × open size* (gross). MFE is its largest value and MAE its smallest, both starting at 0 at the entry. It is sampled at every fill of the round trip (at the fill price, with the position before the fill); at the high and the low of every closed bar the position was held through whole (open from the bar's open, after any fill at that open, with no fill on the contract inside the bar); and at the open of a bar with a fill inside it when the position was held into that bar. A bar with a fill inside it contributes nothing else, since whether its high or low came before or after the fill is unknown: an entry filled inside a bar (a limit or stop entry, or a market order filled at a moment inside a bar) starts from its fill, and on the bar of a stop, target or market exit inside a bar only the bar's open and the fill count. A bar still in progress at the clock never counts as held. `…Dollars` is that P&L; `…R` = dollars ÷ riskDollars; `…Ticks` and `…Points` are the dollars per contract open at that moment (with no partial exit before it, exactly the price's distance from the average entry); `…Time` is the bar's open time (as `get_bars` labels it) or the fill's time.

**Initial stop.** The stop-loss bracket leg of the opening order, priced from the opening fill (as the fill engine places it). Otherwise, among the client `stop` and `trailing_stop` orders on the closing side that were placed before the opening fill or within the minute after it (before the trade's first bar closed and before the trade ended), still working after the fill (one filled or cancelled before it, even at the same instant, belonged to an earlier trade; the server keeps the order of events within an instant), and on the losing side of the entry at their price when they began protecting the trade: the closest to the entry. Later moves don't change it. A trailing stop's ratchets before the entry are not tracked. Stop prices (and cancels) are recorded with their order among fills at placement and at each `modify_order` from this version on; for orders in a run's state from an earlier version, the current price stands in for the original (an earlier move then reads as the initial stop, and its fill as `stop`; a cancel-and-replace made before the upgrade reads `stop`), and events at the entry's instant are ordered by time only. With several stops (scale-out stops), the closest one sets the risk for the whole entry size, so R is on the tighter stop.

**Matching the harness backtester.** The harness's `engine.js` records `r`, `mfeR`, `maeR`, `barsHeld` and `reason` per trade from `sim-broker.js#onBar`, for one fixed-size position. For such a trade the definitions here give the same values, with one documented difference: on the bar of an exit inside the bar, the harness also counts that bar's whole high and low (its MFE uses the high on a stop's bar, its MAE the low on a target's bar). Here that bar counts only its open and the fill, so `mfeR` is never above the harness's, and `maeR` matches on stop exits. The harness has no adds, partial exits or reversals; here they are part of one round trip as described above. The harness's runner-made reasons (`eod`, `max_bars`, `policy`, …) arrive here as `close_position`, so they read `close`.

**Aggregates** (`get_performance.roundTrips.overall` and `byContract`), over the round trips that ended in the window, in exit order. A round trip wins when `net > 0` and loses when `net < 0`, as the harness counts it.

| Field | Definition |
|---|---|
| `trades`, `wins`, `losses`, `scratches`, `winRate` | Counts; wins ÷ trades |
| `grossPnL`, `fees`, `netPnL` | Sums |
| `avgWin`, `avgLoss`, `expectancy` | Average net of winners, of losers, of all ($) |
| `profitFactor` | Net of winners ÷ \|net of losers\| (null with no loss) |
| `maxDrawdown` | Largest peak-to-trough fall of the realized equity curve: cumulative net per round trip, from 0 ($) |
| `tradesWithR` | Round trips with an initial stop; the R fields below use only these |
| `avgWinR`, `avgLossR`, `expectancyR` | Average `rNet` of winners, of losers, of all |
| `avgMaeRWinners`, `avgMfeRWinners`, `avgMaeRLosers`, `avgMfeRLosers` | Average `maeR` and `mfeR` of winners and of losers |
| `winnersPastMinus1R` | Share of winners whose `maeR` reached −1 (down a full R before ending a winner) |
| `avgBarsHeld` | Average `barsHeld` |

The per-fill statistics `get_performance` already returned (`overall`, `byContract`: closing fills, gross P&L per fill) are unchanged.

## Use with the harness

Register it as a broker in `~/.futures-trading-harness/brokers.json` (an entry like the harness's `topstepx` one in `mcp-configs/brokers.json`), with `"replay": true`, then select it with `FTH_BROKER=backtester` (or make it the default with `"broker": "backtester"`):

```json
{
  "brokers": {
    "backtester": {
      "description": "Replay broker over local historical bars (backtester-mcp)",
      "repo": "https://github.com/johnamcruz/backtester-mcp",
      "replay": true,
      "entryEnv": "BACKTESTER_MCP_ENTRY",
      "journal": "~/.backtester-mcp/runs/default/journal.jsonl",
      "journalEnv": "BACKTESTER_JOURNAL_PATH",
      "env": [
        "BACKTESTER_DATA_DIR", "BACKTESTER_CLOCK_FILE", "BACKTESTER_NOW", "BACKTESTER_START", "BACKTESTER_END",
        "BACKTESTER_RUN_ID", "BACKTESTER_STATE_DIR", "BACKTESTER_ACCOUNT_ID", "BACKTESTER_ACCOUNT_NAME",
        "BACKTESTER_START_BALANCE", "BACKTESTER_SLIPPAGE_TICKS", "BACKTESTER_FEES_MICRO", "BACKTESTER_FEES_MINI", "BACKTESTER_MARKET_FILL",
        "BACKTESTER_TRADING_ENABLED", "BACKTESTER_ALLOWED_ACCOUNT_IDS", "BACKTESTER_ALLOWED_SYMBOLS",
        "BACKTESTER_MAX_ORDER_SIZE", "BACKTESTER_MAX_POSITION_SIZE", "BACKTESTER_MAX_DAILY_LOSS",
        "BACKTESTER_JOURNAL_PATH", "BACKTESTER_MCP_ENTRY"
      ],
      "paperEnv": { "BACKTESTER_TRADING_ENABLED": "false" }
    }
  }
}
```

And in the harness home's `.env` (`~/.futures-trading-harness/.env`, or the replay's own `FTH_HOME`):

```bash
BACKTESTER_MCP_ENTRY=/absolute/path/to/backtester-mcp/dist/index.js
BACKTESTER_DATA_DIR=/absolute/path/to/your/data
BACKTESTER_CLOCK_FILE=/absolute/path/to/replay/clock.json
BACKTESTER_RUN_ID=my-replay
BACKTESTER_JOURNAL_PATH=/absolute/path/to/.backtester-mcp/runs/my-replay/journal.jsonl
BACKTESTER_TRADING_ENABLED=true
BACKTESTER_START=2024-03-01T00:00:00Z
BACKTESTER_END=2024-04-01T00:00:00Z
```

Set `BACKTESTER_JOURNAL_PATH` explicitly whenever you change the run id or state folder: the harness's order gate reads the journal from that path. The gateway, the contract translator (`MNQ` → `BT.MNQ`), the order gate and the runner talk to it through the interface as to any broker.

**The harness's clock.** For a replay, set the harness's `FTH_REPLAY_NOW` to the same time as the clock file. The harness honours it only for a replay broker: the selected broker says `"replay": true` in `brokers.json` (and shares no server or variables with a live one), and its server's `get_server_config` reports `replay: true` and a `serverTime` within 5 minutes of `FTH_REPLAY_NOW`, which this server does when both come from the same clock. Otherwise the harness refuses the override and its gate refuses new entries. A process's environment is fixed when it starts, so the harness drives one cycle per process (a fresh harness run or `autotrader.js --once` per clock step), in a harness home of its own (`FTH_HOME`). See the harness's `docs/HARNESS-DESIGN.md`, "Replay clock".

### Conformance check

From a futures-trading-harness checkout, with a clock in session:

```bash
BACKTESTER_DATA_DIR=/path/to/data BACKTESTER_NOW=2024-03-05T15:00:00Z BACKTESTER_STATE_DIR=$(mktemp -d) \
  node scripts/check-broker-mcp.js --symbol MNQ -- node /absolute/path/to/backtester-mcp/dist/index.js
```

It lists the tools, makes read-only calls, and ends with `conforms to the broker MCP interface`.

## Use with Claude (or any MCP client)

```bash
claude mcp add backtester \
  --env BACKTESTER_DATA_DIR=/path/to/data \
  --env BACKTESTER_CLOCK_FILE=/path/to/clock.json \
  --env BACKTESTER_TRADING_ENABLED=true \
  -- node /absolute/path/to/backtester-mcp/dist/index.js
```

Then move the clock with `node dist/clock.js` between turns. `npm run start:http` serves Streamable HTTP at `/mcp` (with `MCP_HTTP_AUTH_TOKEN`).

## Differences from projectx-mcp

| | projectx-mcp | backtester-mcp |
|---|---|---|
| Time | Wall clock | Replay clock (`BACKTESTER_CLOCK_FILE` / `BACKTESTER_NOW`) |
| Contract ids | `CON.F.US.MNQ.H25` | `BT.MNQ` (one continuous series per root; `name` is the front-month ticker) |
| `get_bars` units | second to month | minute, hour, day, week (from one-minute data); `second` and `month` answer an error |
| `get_quote` | SignalR feed | Last closed one-minute bar; `bestBid = bestAsk = lastPrice`; `null` when no bar in 15 minutes |
| Brackets | Only with Auto OCO Brackets on the account | Always available |
| Market orders | Fill at once | Fill at once, at the open of the one-minute bar containing the replay moment plus slippage (`BACKTESTER_MARKET_FILL=next-bar`: at the next bar's open) |
| Accounts | Your TopstepX accounts | One simulated account (`BACKTESTER_ACCOUNT_ID`) |
| Extra result fields | | `get_server_config`: `mode`, `replay`, `window`, `clock`, `data`, run and fill settings; orders: `rejectReason`, `reduceOnly`; fills, positions, performance: [trade metrics](#trade-metrics) |
| Guardrail names | `PROJECTX_*` | `BACKTESTER_*`, plus the replay window |
| No equivalent | `realtime.ts`, `tunnel.ts`, Postman collection | `clock.ts` (the clock and its CLI), `fills.ts`, `bars.ts`, `metrics.ts` |

## Development and testing

```bash
npm run dev        # run from source with tsx (stdio)
npm test           # unit tests (Vitest)
npm run coverage   # tests + coverage report (thresholds in vitest.config.ts enforced)
npm run typecheck
npm run build
```

Every module in `src/` has tests in `test/`, except `index.ts`, which only wires dependencies together. Tests generate tiny synthetic CSVs in temp folders and never read real data. Each MCP tool is exercised through an in-memory MCP client; `test/replay.test.ts` runs the harness's flow (entry with a stop bracket, position, stop moved, exit, fills) and multi-day replays; `test/metrics.test.ts` checks the trade metrics against hand-computed, tick-correct examples. An optional dev check compares them with the harness's simulated broker on the same bars: `FTH_HARNESS_DIR=/path/to/futures-trading-harness npx vitest run test/harness-parity.test.ts` (skipped without it). See [CLAUDE.md](CLAUDE.md) for the layout, the rules, and what to run before a pull request.

## License

Apache-2.0. See [LICENSE](LICENSE). The license covers this code, not any market data you use with it.
