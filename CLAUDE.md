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
- `src/metrics.ts`: trade metrics, pure: round trips (position episodes) from
  one contract's fills and bars, with MAE/MFE, R, bars held and exit reason,
  matching the harness backtester's `engine.js#closeTrade` fields (`r`,
  `mfeR`, `maeR`, `barsHeld`, `reason`) except where documented. Exposed only as
  extra result fields (`search_trades`, `get_performance.roundTrips`,
  positions' `roundTrip`).
- `src/clock.ts`: reading the replay clock; also the clock CLI (`dist/clock.js`).
- `src/risk.ts`: guardrails and trading-day math (pure functions).
- `src/config.ts`, `src/enums.ts`, `src/journal.ts`, `src/performance.ts`,
  `src/http.ts`: as in projectx-mcp.
- `test/`: one Vitest file per module, `server.test.ts` through an in-memory
  MCP client, `replay.test.ts` for the harness flow and multi-day replays,
  `metrics.test.ts` with hand-computed tick-correct trade metrics,
  `harness-parity.test.ts` an optional dev check against the harness (skipped
  without `FTH_HARNESS_DIR`); `helpers.ts` writes tiny synthetic CSVs into
  temp folders.

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

- **Code only.** Never commit market data (CSV, parquet, manifests), run state,
  journals or clock files; `.gitignore` covers them. Tests generate tiny
  synthetic data in temp folders. Real data stays outside the repo and is
  reached through `BACKTESTER_DATA_DIR` (a local `.env`).
- **The contract is the interface.** Tool names, inputs (names, types,
  optional fields, defaults), results, error texts (`Blocked by risk
  guardrail: ...`), outcome codes and the journal format stay identical to the
  harness's `docs/BROKER-MCP-INTERFACE.md` and to projectx-mcp. Extra fields in
  a result are allowed; missing or renamed ones are not. `test/server.test.ts`
  pins projectx-mcp's tool and input lists.
- **Fills match the harness backtester.** The rules in `src/fills.ts` are those
  of the harness's simulated broker, `scripts/lib/backtest/sim-broker.js`
  (the fill model the harness backtester `engine.js` drives), cited by
  function. Change a rule only together with the backtester, and keep the
  citations current. Trade metrics follow the backtester's definitions too
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
