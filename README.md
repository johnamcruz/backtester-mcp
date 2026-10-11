# backtester-mcp

**A replay broker: an MCP server that implements the futures-trading-harness broker interface over local historical bars, with a replay clock and simulated fills.**

It answers with the same tools, inputs, results and errors as [projectx-mcp](https://github.com/johnamcruz/projectx-mcp) (TopstepX), so it is a drop-in replacement at the level of the [broker MCP interface](https://github.com/johnamcruz/futures-trading-harness/blob/main/docs/BROKER-MCP-INTERFACE.md): same tools, schemas and results. Only three things are simulated: the **data** (your one-minute CSVs), the **clock** (a file the replay driver advances), and the **fills** (the harness backtester's rules). Use it to backtest a harness end to end, or to replay a day the way it would have traded live.

> [!IMPORTANT]
> Replaying through the futures-trading-harness also needs the harness's own replay clock, which is still pending (a harness pull request). Until it lands, the harness's order gate uses the wall clock. Once it lands, set `FTH_REPLAY_NOW` to the same time as the clock file: the harness honours it only for a broker whose `get_server_config` reports `replay: true` and a `serverTime` within about 5 minutes of it, which this server does.

> [!NOTE]
> This repository holds code only. It ships no market data: bring your own, keep it outside the repo, and point `BACKTESTER_DATA_DIR` at it. Market data is usually licensed; don't commit or redistribute it.

## What the model gets

| Area | Tools |
|---|---|
| Session | `get_server_config`: trading enabled, the guardrails, plus the replay window, clock and data range per symbol |
| Accounts | `list_accounts`, `get_account_snapshot` (balance, positions, working orders, today's P&L vs. the loss limit) |
| Market data | `search_contracts`, `get_contract`, `list_available_contracts`, `get_bars` (closed bars up to the replay clock), `get_quote` (last close) |
| Trading | `place_order` (market, limit, stop, trailing stop, join bid/ask, with stop-loss/take-profit brackets), `modify_order`, `cancel_order`, `close_position`, `partial_close_position` |
| History | `list_open_orders`, `search_orders`, `list_open_positions`, `search_trades` |
| Learning | `get_performance`, `journal_add`, `journal_read` |

These are the same 20 tools as projectx-mcp, with the same input fields, defaults and result shapes. The server also sends an operating guide (`backtester://guide`, the first half of [AGENTS.md](AGENTS.md)), MCP server instructions, and a `trading_session` prompt.

### Guardrails the model cannot override

The same checks and semantics as projectx-mcp's, with `BACKTESTER_` names:

| Setting | Default | Effect |
|---|---|---|
| `BACKTESTER_TRADING_ENABLED` | `false` | Order tools are refused unless this is `true`. Read-only tools always work. |
| `BACKTESTER_ALLOWED_ACCOUNT_IDS` | any | Only these accounts can be traded. |
| `BACKTESTER_ALLOWED_SYMBOLS` | any | Contract roots, e.g. `MNQ,MES` (ids are `BT.<ROOT>`). |
| `BACKTESTER_MAX_ORDER_SIZE` | `1` | Maximum contracts per order. |
| `BACKTESTER_MAX_POSITION_SIZE` | `2` | Maximum absolute net position per contract, counting every resting same-side order that could fill (limit, join, stop and trailing stop) and market orders waiting for the next bar when they add to the position or go through flat (bracket legs and closes never count), also when `modify_order` grows a resting order. An order is checked (position and daily loss) when it opens exposure: the worst case ends further from flat, or the order itself goes through flat. Pure reduction and protective orders (a stop and a target covering the position) are always allowed. |
| `BACKTESTER_MAX_DAILY_LOSS` | `500` | Once realized P&L after fees for the trading day (from 17:00 CT / 18:00 ET, replay time) reaches −this amount, only orders that reduce the position are allowed. `0` turns it off. |
| `BACKTESTER_START` / `BACKTESTER_END` | none | Orders that add exposure are refused while the replay clock is outside the window; closes, cancels and risk-reducing orders are not. |

Refusals read `Blocked by risk guardrail: …` and are journaled as `order_blocked`, as with projectx-mcp.

The max position and the daily loss limit are also **enforced when an order fills**, as a broker enforces server-side limits. A placement check alone can't be sound here: a close, a bracket leg or a reducing market order can flatten the position first, and an opposite order accepted earlier would then fill as a new entry. So before any fill of a client order, the server checks the position the fill would leave: a fill that opens exposure (grows the position or goes through flat) past `BACKTESTER_MAX_POSITION_SIZE`, or while the daily loss limit is reached, is rejected whole: the order gets status `rejected` (5) with a `rejectReason` in `search_orders`, and nothing fills. Reducing fills, bracket legs and closes are never rejected. Fills are checked one at a time against the position the fills before them left. A fill that goes through flat and would breach the max position or the daily loss limit is rejected whole, the reducing half too (simplest to reason about: an order either fills as sent or not at all); within the limits it fills normally. At placement, an order that by itself only reduces the position is never refused, whatever rests beside it.

A stop or target you placed yourself (not a bracket leg) and left resting after the position closed is your own order: when it triggers it fills as a new entry if that stays within the limits, or comes back `rejected` with a `rejectReason` if it would breach one. Cancel leftovers after a close.

**Order of fills.** Each one-minute bar has two moments: its open (waiting market orders fill) and its close (resting orders settle against its range). All opens of a minute come before any of its closes. Within a contract the order never changes: market orders by arrival, resting orders stops first, then by order id. Across contracts, each moment runs in two passes: first every contract's fills up to (not including) its first fill that would open exposure, then the rest of every contract in the same order. So realized gains and losses at a moment on other contracts count before an opening fill: since the order inside a minute is unknown, this is pessimistic for losses (a same-minute loss can block an entry) and optimistic for gains (a same-minute gain can lift a daily-loss block).

## Setup

Requires Node.js 20.12 or later.

```bash
git clone https://github.com/johnamcruz/backtester-mcp && cd backtester-mcp
npm install
npm run build
cp .env.example .env    # then set BACKTESTER_DATA_DIR and a clock
```

### Data

`BACKTESTER_DATA_DIR` is a folder of one-minute files, one per root:

```text
<data>/NQ_1min.csv   ES_1min.csv   YM_1min.csv   RTY_1min.csv   GC_1min.csv   SI_1min.csv   CL_1min.csv
```

```csv
datetime,open,high,low,close,volume
2024-03-05 15:00:00+00:00,20466.0,20495.75,20464.5,20490.75,6162.0
```

- Timestamps are UTC (`YYYY-MM-DD HH:MM:SS+00:00` or ISO with `Z`) and mark the bar's **open**; rows are oldest first. Each file is a back-adjusted continuous series.
- Micros replay their mini's file at the micro's tick value: MNQ→`NQ_1min.csv`, MES→ES, MYM→YM, M2K→RTY, MGC→GC, SIL→SI, MCL→CL.
- Only the one-minute file is read. Other timeframes (`<ROOT>_3min.csv` and so on, if present) are ignored, because `get_bars` builds every bar size from the one-minute bars.
- A file is loaded once per process, when first needed.

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

Every option is in [.env.example](.env.example). Settings come from the environment (an MCP client's `env` block, or the variables a harness forwards) or a `.env` file (`BACKTESTER_ENV_FILE` names another).

| Variable | Default | Meaning |
|---|---|---|
| `BACKTESTER_DATA_DIR` | required | Folder of `<ROOT>_1min.csv` files |
| `BACKTESTER_CLOCK_FILE` | | Replay clock file, `{ "now": "<ISO>" }`, re-read on every call |
| `BACKTESTER_NOW` | | Fixed replay time when there is no clock file (one of the two is required) |
| `BACKTESTER_START` / `BACKTESTER_END` | none | The replay window (ISO, UTC) |
| `BACKTESTER_RUN_ID` | `default` | Names the run |
| `BACKTESTER_STATE_DIR` | `~/.backtester-mcp/runs/<run id>` | The run's state (account, orders, fills) and default journal |
| `BACKTESTER_ACCOUNT_ID` / `BACKTESTER_ACCOUNT_NAME` | `1` / `BACKTEST-<run id>` | The simulated account |
| `BACKTESTER_START_BALANCE` | `100000` | Starting balance |
| `BACKTESTER_SLIPPAGE_TICKS` | `1` | Ticks of slippage per market and stop fill |
| `BACKTESTER_FEES_MICRO` / `BACKTESTER_FEES_MINI` | `0.37` / `1.40` | Fees per side per contract |
| `BACKTESTER_JOURNAL_PATH` | `<state dir>/journal.jsonl` | The journal (same JSONL format as projectx-mcp's) |
| guardrails | see above | `BACKTESTER_TRADING_ENABLED`, `…_ALLOWED_ACCOUNT_IDS`, `…_ALLOWED_SYMBOLS`, `…_MAX_ORDER_SIZE`, `…_MAX_POSITION_SIZE`, `…_MAX_DAILY_LOSS` |
| `PORT`, `HOST`, `MCP_HTTP_AUTH_TOKEN` | `8787`, `127.0.0.1` | HTTP mode (`--http`), as in projectx-mcp |

## The replay clock

The server's "now" is the replayed time, never the wall clock. It reads `BACKTESTER_CLOCK_FILE` on every call, falling back to `BACKTESTER_NOW`. A replay driver, such as the harness's, writes the file and moves it forward; the server reacts on the next call:

- **On every call**, before answering, the run is synced to the clock: every one-minute bar between the last synced time and now is processed in order. A bar's **open** fills market orders waiting for it; its **close** (once `t + 1 min <= now`) settles resting orders against its high and low.
- `get_bars` and `get_quote` see only bars closed by now (capped at `BACKTESTER_END`). `includePartialBar: true` adds the bucket still forming, built from closed one-minute bars only.
- The clock may only move forward within a run. A clock earlier than the run's synced time is an error: start a new run instead.
- Results depend only on the data, the window, the clock sequence and the orders: the same inputs give the same fills.

Drive the clock by hand with the clock CLI:

```bash
node dist/clock.js --file /tmp/clock.json --set 2024-03-05T14:30:00Z
node dist/clock.js --file /tmp/clock.json --step 1        # one minute
node dist/clock.js --file /tmp/clock.json --next-bar 5    # to the next 5-minute close
node dist/clock.js --file /tmp/clock.json                 # print it
```

### The replay window and runs

`BACKTESTER_START` and `BACKTESTER_END` bound a run. Bars before `START` stay available to `get_bars` as lookback history; trading and the account begin at `START`. After `END`, `get_bars` is capped at `END`. While the clock is before `START` or after `END`, orders that add exposure answer `Blocked by risk guardrail: …`. Closes, cancels and risk-reducing orders are still taken, so a position open at `END` can be flattened: once no bar is left to fill on before `END` (the clock is at or past `END`, or the next bar opens after it), `close_position`, `partial_close_position` and market orders that reduce the position fill at the last close at or before the clock (and `END`), without slippage (as the harness backtester settles a trade still open at the end of its data); other orders are refused with `OutsideTradingHours`.

All mutable state lives in the run's folder (`BACKTESTER_STATE_DIR`, by default `~/.backtester-mcp/runs/<BACKTESTER_RUN_ID>`): `state.json` and, unless `BACKTESTER_JOURNAL_PATH` says otherwise, `journal.jsonl`. Every process started with the same folder shares the run (the harness starts the server more than once: its gateway and its runner); a lock file serializes their calls (data files load before the lock). A run records its account and fill settings (account id, start balance, slippage, fees) when it is created, and refuses a process configured differently. Give parallel replays different run ids. To replay again from the start, use a new run id or delete the folder.

## Fills

The fill engine (`src/fills.ts`) is ported from the harness's simulated broker (`scripts/lib/backtest/sim-broker.js`, extracted from the backtester's `engine.js` in harness PR #23; cited by function in the code), so a replay fills the way a backtest does:

| Order | Fill |
|---|---|
| Market (entries, `close_position`, `partial_close_position`) | The next one-minute bar's open plus `BACKTESTER_SLIPPAGE_TICKS` in the order's direction. If the clock is on a bar's open, that bar; otherwise the order waits for the next minute. Closes only reduce. A waiting `close_position` fills in arrival order with the contract's other waiting market orders and flattens whatever is open when it fills, so the position ends flat even with an add waiting beside it. If something else flattens the position first, the close stays open (a reduce-only order on a flat contract, visible in `list_open_orders`) until its bar: it then flattens any entry sent before it that reopened the position, or cancels itself if the contract is still flat. A partial close never closes more than is open. `close_position` is always taken and means "flat after everything sent before it": beside a waiting partial close (the partial fills, the close takes the rest); a second one while one waits is a no-op (success, nothing added), unless a client market order arrived after the waiting close, in which case the close moves to the end of the arrival order (the waiting one is cancelled, a new one goes in after that order). While a close waits, new orders are checked at placement against the flat position it will leave (a sell "reducing" a long the close removes is an opening order: limits and the daily loss apply). A partial close while a `close_position` waits reduces what was sent after the close (sized against the position the close leaves plus later market orders); with nothing sent after it, it answers `OrderPending`. Partial closes, like `close_position`, are never cancelled by other fills: each closes what it can when it fills and cancels itself otherwise. |
| Stop (`stop`, stop-loss legs, trailing stops) | The stop price less slippage; if the bar opens through the stop, the bar's open less slippage. |
| Limit (`limit`, take-profit legs, `join_bid`/`join_ask`) | The limit price, or a better open. No slippage. Touch fills. |
| Stop and target touched in one bar | The stop fills (the conservative reading). |
| Brackets | Legs sit `ticks` from the entry's fill price (slippage included); a market entry's legs are checked on the fill bar itself. A filled leg cancels its sibling (OCO); all bracket legs are cancelled when the position is flat or reverses, and a leg never opens a new position. An order that only reduces the position gets no legs (they would sit on the wrong side); one that goes through flat gets legs for the new part. |
| Limit or stop entries filled inside a bar | Their stop-loss leg is checked on the same bar too (pessimistic); the take-profit leg from the next bar. |
| Orders placed inside a bar | Checked from the next bar that opens at or after that moment (no look-back). |
| Orders modified or cancelled | Take effect at once, as at a live broker (and the harness sim-broker's `cancel()`): a cancelled order never fills, and a modified order is checked on its new terms from the bar in progress on (not yet settled), so it is never skipped for a bar. Note that a modify inside a bar applies to that whole bar, up to 59 seconds before the modify: the bar's range is settled only when it closes, so no later price is used, but a moved stop can fill on a price from earlier in that minute. |
| Trailing stop | Placed at `trailPrice` (a level); after each bar the stop follows the bar's extreme at the original distance, never loosening. The harness runner trails with `modify_order` instead. |
| P&L and fees | Ticks × tick value × size; fees per side per contract on every fill. Daily P&L resets at 17:00 CT (18:00 ET). |

Orders are refused (`OutsideTradingHours`) when the market is closed at the replay time: when the next one-minute bar after now falls in a later trading day (the daily break, weekends, holidays) or there is no data after now.

## Use with the harness

Register it as a broker in `~/.futures-trading-harness/brokers.json` (an entry like the harness's `topstepx` one in `mcp-configs/brokers.json`), then select it with `FTH_BROKER=backtester`, or make it the default with `"broker": "backtester"`:

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
        "BACKTESTER_START_BALANCE", "BACKTESTER_SLIPPAGE_TICKS", "BACKTESTER_FEES_MICRO", "BACKTESTER_FEES_MINI",
        "BACKTESTER_TRADING_ENABLED", "BACKTESTER_ALLOWED_ACCOUNT_IDS", "BACKTESTER_ALLOWED_SYMBOLS",
        "BACKTESTER_MAX_ORDER_SIZE", "BACKTESTER_MAX_POSITION_SIZE", "BACKTESTER_MAX_DAILY_LOSS",
        "BACKTESTER_JOURNAL_PATH", "BACKTESTER_MCP_ENTRY"
      ],
      "paperEnv": { "BACKTESTER_TRADING_ENABLED": "false" }
    }
  }
}
```

And in `~/.futures-trading-harness/.env`:

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

Set `BACKTESTER_JOURNAL_PATH` explicitly whenever you change the run id or state folder: the harness's order gate reads the journal from that path. The gateway, the contract translator (`MNQ` → `BT.MNQ`), the order gate and the runner talk to it through the interface as to any broker; for a replay, also set the harness's `FTH_REPLAY_NOW` to the clock's time once the harness's replay clock lands (see the note at the top).

### Conformance check

From a futures-trading-harness checkout, with a clock in session:

```bash
BACKTESTER_DATA_DIR=/path/to/data BACKTESTER_NOW=2024-03-05T15:00:00Z BACKTESTER_STATE_DIR=$(mktemp -d) \
  node scripts/check-broker-mcp.js --symbol MNQ -- node /absolute/path/to/backtester-mcp/dist/index.js
```

It lists the tools and makes read-only calls, and ends with `conforms to the broker MCP interface`.

## Use with Claude (or any MCP client)

```bash
claude mcp add backtester \
  --env BACKTESTER_DATA_DIR=/path/to/data \
  --env BACKTESTER_CLOCK_FILE=/path/to/clock.json \
  --env BACKTESTER_TRADING_ENABLED=true \
  -- node /absolute/path/to/backtester-mcp/dist/index.js
```

Then move the clock with `node dist/clock.js` between turns. `npm run start:http` serves Streamable HTTP at `/mcp` (with `MCP_HTTP_AUTH_TOKEN`, as in projectx-mcp).

## Differences from projectx-mcp

| | projectx-mcp | backtester-mcp |
|---|---|---|
| Time | Wall clock | Replay clock (`BACKTESTER_CLOCK_FILE` / `BACKTESTER_NOW`) |
| Contract ids | `CON.F.US.MNQ.H25` | `BT.MNQ` (one continuous series per root; `name` is the front-month ticker) |
| `get_bars` units | second to month | minute, hour, day, week (from one-minute data); `second` and `month` answer an error |
| `get_quote` | SignalR feed | Last closed one-minute bar; `bestBid = bestAsk = lastPrice`; `null` when no bar in 15 minutes |
| Brackets | Only with Auto OCO Brackets on the account | Always available |
| Market orders | Fill at once | Fill at the next one-minute bar's open (at once when the clock is on a minute boundary) |
| Accounts | Your TopstepX accounts | One simulated account (`BACKTESTER_ACCOUNT_ID`) |
| Extra in `get_server_config` | | `mode`, `window`, `clock`, `data`, run and fill settings |
| Guardrail names | `PROJECTX_*` | `BACKTESTER_*`, plus the replay window |
| No equivalent | `realtime.ts`, `tunnel.ts`, Postman collection | `clock.ts` (the clock and its CLI), `fills.ts`, `bars.ts` |

## Development

```bash
npm run dev        # run from source with tsx (stdio)
npm test           # unit tests (Vitest)
npm run coverage   # tests + coverage report (thresholds enforced)
npm run typecheck
npm run build
```

Every module in `src/` has tests in `test/`, except `index.ts`, which only wires dependencies together. Tests generate tiny synthetic CSVs in temp folders and never read real data. Each MCP tool is exercised through an in-memory MCP client; `test/replay.test.ts` runs the harness's flow (entry with a stop bracket, position, stop moved, exit, fills) and multi-day replays. See [CLAUDE.md](CLAUDE.md) for the layout, the rules, and what to run before a pull request.

## License

Apache-2.0. See [LICENSE](LICENSE).
