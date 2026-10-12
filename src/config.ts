import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface Config {
  /** Folder of `<ROOT>_1min.csv` files (local only; never in the repo). */
  dataDir: string;
  /** JSON file `{ "now": "<ISO>" }` the replay driver writes; re-read on every call. */
  clockFile: string | null;
  /** Fixed replay time when there is no clock file (BACKTESTER_NOW). */
  fixedNow: string | null;
  /** Replay window (ms, UTC). Trading and the account start at `start`; nothing happens after `end`. */
  start: number | null;
  end: number | null;
  runId: string;
  /** Per-run folder holding all mutable state (account, orders, fills) and, by default, the journal. */
  stateDir: string;
  statePath: string;
  startBalance: number;
  slippageTicks: number;
  feesMicro: number;
  feesMini: number;
  /**
   * When market orders fill (BACKTESTER_MARKET_FILL): "now" (the default) at the replay moment they
   * are placed, at the open of the one-minute bar containing it, as live; "next-bar" at the open of
   * the next bar starting at or after it (the rule before this setting existed). Pinned per run.
   */
  marketFill: MarketFill;
  accountId: number;
  accountName: string;
  tradingEnabled: boolean;
  allowedAccountIds: number[];
  allowedSymbols: string[];
  maxOrderSize: number;
  maxPositionSize: number;
  maxDailyLoss: number;
  journalPath: string;
}

type Env = Record<string, string | undefined>;

export const MARKET_FILLS = ["now", "next-bar"] as const;
export type MarketFill = (typeof MARKET_FILLS)[number];

function marketFill(env: Env): MarketFill {
  const raw = env.BACKTESTER_MARKET_FILL?.trim().toLowerCase();
  if (!raw) return "now";
  if (!(MARKET_FILLS as readonly string[]).includes(raw)) throw new Error(`BACKTESTER_MARKET_FILL must be "now" or "next-bar", got "${env.BACKTESTER_MARKET_FILL}"`);
  return raw as MarketFill;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number, got "${raw}"`);
  return n;
}

function time(env: Env, key: string): number | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(`${key} must be an ISO date or time (UTC), got "${raw}"`);
  return ms;
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

const abs = (p: string) => (isAbsolute(p) ? p : resolve(p));

export function loadConfig(env: Env = process.env): Config {
  const dataDir = env.BACKTESTER_DATA_DIR?.trim() ?? "";
  if (!dataDir) {
    throw new Error(
      "BACKTESTER_DATA_DIR must be set (in the MCP client's env block or a .env file): a folder of <ROOT>_1min.csv files. " +
        "Data is never part of this repo; bring your own.",
    );
  }
  const clockFile = env.BACKTESTER_CLOCK_FILE?.trim() || null;
  const fixedNow = env.BACKTESTER_NOW?.trim() || null;
  if (!clockFile && !fixedNow) {
    throw new Error("Set BACKTESTER_CLOCK_FILE (a JSON file { \"now\": \"<ISO>\" } the replay driver advances) or BACKTESTER_NOW (a fixed replay time).");
  }
  if (fixedNow && !Number.isFinite(Date.parse(fixedNow))) throw new Error(`BACKTESTER_NOW must be an ISO time, got "${fixedNow}"`);
  const start = time(env, "BACKTESTER_START");
  const end = time(env, "BACKTESTER_END");
  if (start !== null && end !== null && end <= start) throw new Error("BACKTESTER_END must be after BACKTESTER_START.");
  const runId = env.BACKTESTER_RUN_ID?.trim() || "default";
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.startsWith(".")) {
    throw new Error(`BACKTESTER_RUN_ID may hold only letters, digits, ".", "_" and "-", got "${runId}"`);
  }
  const stateDir = abs(expandHome(env.BACKTESTER_STATE_DIR?.trim() || join("~/.backtester-mcp/runs", runId)));
  const allowedAccountIds = list(env.BACKTESTER_ALLOWED_ACCOUNT_IDS).map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n)) throw new Error(`BACKTESTER_ALLOWED_ACCOUNT_IDS contains a non-integer: "${s}"`);
    return n;
  });
  const accountId = num(env, "BACKTESTER_ACCOUNT_ID", 1);
  if (!Number.isInteger(accountId)) throw new Error("BACKTESTER_ACCOUNT_ID must be an integer.");
  const startBalance = num(env, "BACKTESTER_START_BALANCE", 100000);
  if (startBalance <= 0) throw new Error("BACKTESTER_START_BALANCE must be positive.");
  return {
    dataDir: abs(expandHome(dataDir)),
    clockFile: clockFile ? abs(expandHome(clockFile)) : null,
    fixedNow,
    start,
    end,
    runId,
    stateDir,
    statePath: join(stateDir, "state.json"),
    startBalance,
    slippageTicks: num(env, "BACKTESTER_SLIPPAGE_TICKS", 1),
    feesMicro: num(env, "BACKTESTER_FEES_MICRO", 0.37),
    feesMini: num(env, "BACKTESTER_FEES_MINI", 1.4),
    marketFill: marketFill(env),
    accountId,
    accountName: env.BACKTESTER_ACCOUNT_NAME?.trim() || `BACKTEST-${runId}`,
    tradingEnabled: env.BACKTESTER_TRADING_ENABLED?.trim().toLowerCase() === "true",
    allowedAccountIds,
    allowedSymbols: list(env.BACKTESTER_ALLOWED_SYMBOLS).map((s) => s.toUpperCase()),
    maxOrderSize: num(env, "BACKTESTER_MAX_ORDER_SIZE", 1),
    maxPositionSize: num(env, "BACKTESTER_MAX_POSITION_SIZE", 2),
    maxDailyLoss: num(env, "BACKTESTER_MAX_DAILY_LOSS", 500),
    journalPath: abs(expandHome(env.BACKTESTER_JOURNAL_PATH?.trim() || join(stateDir, "journal.jsonl"))),
  };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Config safe to show the model. The interface's fields first, then the replay's own. */
export function publicConfig(c: Config) {
  return {
    apiUrl: `file://${c.dataDir}`,
    username: "replay",
    tradingEnabled: c.tradingEnabled,
    allowedAccountIds: c.allowedAccountIds.length ? c.allowedAccountIds : "any",
    allowedSymbols: c.allowedSymbols.length ? c.allowedSymbols : "any",
    maxOrderSize: c.maxOrderSize,
    maxPositionSize: c.maxPositionSize,
    maxDailyLoss: c.maxDailyLoss || "off",
    journalPath: c.journalPath,
    mode: "replay" as const,
    replay: true,
    runId: c.runId,
    stateDir: c.stateDir,
    window: { start: iso(c.start), end: iso(c.end) },
    clock: c.clockFile ? { file: c.clockFile } : { fixed: c.fixedNow },
    startBalance: c.startBalance,
    slippageTicks: c.slippageTicks,
    feesPerSide: { micro: c.feesMicro, mini: c.feesMini },
    marketFill: c.marketFill,
  };
}
