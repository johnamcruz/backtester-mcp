# CLAUDE.md

Guidance for coding agents working on this repository (Claude Code reads this
file; Codex, Qwen Code and others read `AGENTS.md`, which points here). The
trading agent's guide is the first half of `AGENTS.md`, served as the MCP
resource `backtester://guide`.

## Project

`backtester-mcp` is a broker MCP server for backtesting and replay. It
implements the broker MCP interface of
[futures-trading-harness](https://github.com/johnamcruz/futures-trading-harness)
(`docs/BROKER-MCP-INTERFACE.md`, as data in `scripts/lib/broker/interface.js`),
the same contract and the same tools as
[projectx-mcp](https://github.com/johnamcruz/projectx-mcp) (TopstepX), over
local historical one-minute bars with a replay clock and simulated fills. It is
a drop-in replacement at the MCP-interface level (same tools, schemas,
results): a harness selects it by broker config (a `brokers.json` entry with
`"replay": true`, `FTH_BROKER=backtester`). For a replay, the harness's
`FTH_REPLAY_NOW` is set equal to the clock file's time: the harness honours it
only for a replay broker whose `get_server_config` reports `replay: true` and
a `serverTime` within 5 minutes of it.

## Layout

Same structure as projectx-mcp; `client.ts` is the replay exchange instead of
the ProjectX REST client.

- `src/index.ts`: entry point (`node dist/index.js`, `--http`). Wiring only.
- `src/server.ts`: every MCP tool, the `backtester://guide` resource, the
  `trading_session` prompt. Tool names, input schemas, result shapes and error
  texts mirror projectx-mcp's `server.ts`.
- `src/client.ts`: the replay exchange: contracts and tick specs, the run's
  state file (locked per call, shared by every process of a run), syncing to
  the clock, orders, positions, fills, bars, quotes.
- `src/fills.ts`: the fill engine, pure functions over one contract's book and
  one bar, ported from the harness simulated broker with citations
  (`sim-broker.js#<function>`). The parity target.
- `src/bars.ts`: CSV loading and aggregation of one-minute bars.
- The derived store (raw contract-month bars for NQ/MNQ from the local L1/L2 order-book
  parquet; README "Local order-book data"): `src/calendar.ts` (ET days, Globex hours, the
  quarterly roll rule), `src/parquet.ts` (hyparquet + node:zlib zstd, one row group at a
  time), `src/events.ts` (normalized trades, quotes, L2 changes; bars from trades),
  `src/rolltable.ts` + `src/rolltable-nq.ts` (the reviewed roll table: the only source of contract assignment; derived with `scripts/derive-roll-table.ts`),
  `src/holidays-cme.ts` (the reviewed CME holiday calendar: closures, early closes), `src/quarantine-nq.ts` (the reviewed
  quarantine: source row groups with a wrong clock, never served), `src/dayassign.ts` (which row group serves which ET day,
  by the rows' own timestamps; conflicts; minute gap runs), `src/store.ts` (layout, reader, events),
  `src/storebuild.ts` and the CLI `src/build-store.ts` (`npm run build-store`). Where the
  store covers the clock, NQ/MNQ contracts are `BT.<ROOT>.<code>` (e.g. `BT.MNQ.M24`);
  elsewhere the CSV series `BT.<ROOT>`.
- Order flow on `get_bars` (`includeOrderFlow`, `flowWindows`; README "Order flow"): projectx-mcp's live field
  contract reproduced from history. `src/orderflow.ts` (ported from projectx-mcp's `src/orderflow.ts`, cited by
  function), `src/flowengine.ts` (the history engine), `src/flowstore.ts` (flow files built by `build-store`, versioned
  by `FLOW_FORMAT` in the manifest; completeness and the replay-clock clamp), `src/flowtools.ts` (`get_bars`' assembly).
- `src/metrics.ts`: trade metrics, pure: round trips (position episodes) from
  one contract's fills and bars, with MAE/MFE, R, bars held and exit reason,
  matching the harness backtester's `engine.js#closeTrade` fields (`r`,
  `mfeR`, `maeR`, `barsHeld`, `reason`) except where documented. Exposed only as
  extra result fields (`search_trades`, `get_performance.roundTrips`,
  positions' `roundTrip`).
- `src/clock.ts`: reading the replay clock; also the clock CLI (`dist/clock.js`).
- `src/risk.ts`: guardrails and trading-day math (pure functions).
- `src/protect.ts`: projectx-mcp's bracket rules (minimum distance, signs) and the protection
  check after a bracketed market entry, step for step over the replay state; `src/ticks.ts`:
  projectx-mcp's tick rounding (`snapped`). `client.ts#flatten` is close_position's flatten
  (close, cancel the contract's orders once flat, verify).
- `src/config.ts`, `src/enums.ts`, `src/journal.ts`, `src/performance.ts`,
  `src/http.ts`: as in projectx-mcp.
- `test/`: one Vitest file per module, `server.test.ts` through an in-memory
  MCP client, `replay.test.ts` for the harness flow and multi-day replays,
  `metrics.test.ts` with hand-computed tick-correct trade metrics,
  `parity.test.ts` pins the order tools' results (fields, types, statuses, messages,
  error codes) against copies of projectx-mcp's, `harness-parity.test.ts` an optional dev check against the harness (skipped
  without `FTH_HARNESS_DIR`); `helpers.ts` writes tiny synthetic CSVs into
  temp folders, `orderbook.ts` and `storefixture.ts` tiny synthetic order-book
  parquet and a store built from it; `vectors.test.ts` runs projectx-mcp's golden order-flow vectors
  (`test/vectors/projectx/`, through the converter `flowvectors.ts`; `PROJECTX_MCP_DIR` adds a byte-identity check
  against the pinned projectx-mcp commit).

## Commands

```bash
npm run typecheck
npm test                 # vitest run
npm run coverage         # thresholds in vitest.config.ts are enforced
npm run build            # tsc -> dist/
# conformance, from a futures-trading-harness checkout:
BACKTESTER_DATA_DIR=<data> BACKTESTER_NOW=2024-03-05T15:00:00Z BACKTESTER_STATE_DIR=$(mktemp -d) \
  node scripts/check-broker-mcp.js --symbol MNQ -- node /abs/path/backtester-mcp/dist/index.js
```

## Hard rules

- **Code only.** Never commit market data (CSV, parquet, manifests, the derived store), run state,
  journals or clock files; `.gitignore` covers them. Tests generate tiny
  synthetic data in temp folders. Real data stays outside the repo and is
  reached through `BACKTESTER_DATA_DIR` (a local `.env`).
- **The contract is the interface.** Tool names, inputs (names, types,
  optional fields, defaults), results, error texts (`Blocked by risk
  guardrail: ...`), outcome codes and the journal format stay identical to the
  harness's `docs/BROKER-MCP-INTERFACE.md` and to projectx-mcp. Extra fields in
  a result are allowed; missing or renamed ones are not. `test/server.test.ts`
  pins projectx-mcp's tool and input lists, `test/parity.test.ts` its order
  results. projectx-mcp (live) is the reference: when the two differ, this
  server adapts, never the other way round. Intentional differences are listed
  in README's "Differences from projectx-mcp".
- **Fills match the harness backtester.** The rules in `src/fills.ts` are those
  of the harness's simulated broker, `scripts/lib/backtest/sim-broker.js`
  (the fill model the harness backtester `engine.js` drives), cited by
  function. Change a rule only together with the backtester, and keep the
  citations current. One rule is the replay's own, by the owner's decision
  that replay must behave like the live market: with `BACKTESTER_MARKET_FILL=now`
  (the default, pinned per run) a market order fills at the replay moment it is
  placed, at the open of the bar containing it plus slippage, reading nothing
  after that moment (`fills.ts#fillOnArrival`); at a bar boundary that is the
  sim-broker's fill exactly. Runs created before it keep `next-bar`. Trade metrics follow the backtester's definitions too
  (`src/metrics.ts`); `test/harness-parity.test.ts` compares them with the
  harness's sim-broker when `FTH_HARNESS_DIR` points at a harness checkout.
- **Deterministic.** A run's results depend only on the data, the window, the
  clock sequence and the orders. No wall clock in fills, state or journal
  timestamps; no randomness.
- **Guardrails are projectx-mcp's.** Every order tool calls
  `assertTradingAllowed` and the window check; checks that add exposure go
  through `risk.ts`. Never weaken a guardrail default.
- **Never write to stdout** in the server: stdio mode uses it for MCP. Log to stderr.
- Write tools get `destructiveHint: true`; read tools get `readOnlyHint: true`.
- New code comes with tests in `test/`; new tools with a test in
  `test/server.test.ts`.
- Example and test arithmetic must be tick-correct (MNQ/MES tick 0.25; MNQ
  $0.50/tick, MES $1.25/tick).
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Before a pull request (hard rule)

Every coding agent and every person changing this repository does both of
these before opening or updating a pull request, every time:

1. **Regression.** `npm run typecheck`, `npm test`, and `npm run build` pass,
   and the harness's `scripts/check-broker-mcp.js` reports
   `conforms to the broker MCP interface` against the built server (command
   above, with real or synthetic data and a clock in session).
2. **Adversarial review.** A reviewer other than the author of the change (a
   separate agent or subagent with no stake in it, or a person) reviews the
   whole diff against the base branch, trying to break it: guardrails that
   fail open, fills that differ from the backtester or look ahead of the
   clock, state shared between runs or lost between processes, a clock moving
   backwards, contract drift from the interface or projectx-mcp, data
   committed, and tests that would pass without the code they claim to cover.
   Every confirmed finding is fixed (or answered with the reason), then the
   regression runs again, until a round confirms nothing new.

The pull request description says what was run and what the review found and fixed.
