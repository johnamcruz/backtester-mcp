import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReplayExchange } from "../src/client.js";
import { writeClock } from "../src/clock.js";
import { loadConfig } from "../src/config.js";
import { Journal } from "../src/journal.js";
import { createServer, type Deps } from "../src/server.js";

/** Tuesday 2024-03-05 15:00 UTC (10:00 ET): mid-session. */
export const T0 = Date.parse("2024-03-05T15:00:00Z");
export const MIN = 60000;
export const iso = (ms: number) => new Date(ms).toISOString();

/** [t (ms), open, high, low, close, volume?] */
export type Row = [number, number, number, number, number, number?];

export function csv(rows: Row[]): string {
  const ts = (ms: number) => iso(ms).replace("T", " ").replace(".000Z", "+00:00");
  return "datetime,open,high,low,close,volume\n" + rows.map(([t, o, h, l, c, v]) => `${ts(t)},${o},${h},${l},${c},${v ?? 10}`).join("\n") + "\n";
}

/** n one-minute bars from `start`, all at `price` (o = h = l = c). */
export function flat(start: number, n: number, price: number): Row[] {
  return Array.from({ length: n }, (_, i) => [start + i * MIN, price, price, price, price] as Row);
}

/** Bars from [o, h, l, c] tuples, one minute apart from `start`. */
export function seq(start: number, ohlc: Array<[number, number, number, number]>): Row[] {
  return ohlc.map(([o, h, l, c], i) => [start + i * MIN, o, h, l, c] as Row);
}

export function tmp(prefix = "btm-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeData(dir: string, data: Record<string, Row[]>): void {
  mkdirSync(dir, { recursive: true });
  for (const [root, rows] of Object.entries(data)) writeFileSync(join(dir, `${root}_1min.csv`), csv(rows));
}

/** Default data: NQ flat at 20000 for two hours around T0. */
export const defaultData = (): Record<string, Row[]> => ({ NQ: flat(T0 - 60 * MIN, 180, 20000) });

export interface SetupOptions {
  env?: Record<string, string>;
  data?: Record<string, Row[]>;
  now?: number;
  /** Reuse a folder (data, clock and state) across setups: several processes on one run. */
  dir?: string;
}

/** A server over synthetic data, an in-memory MCP client, and a clock file to move. */
export async function setup(opts: SetupOptions = {}) {
  const dir = opts.dir ?? tmp();
  const dataDir = join(dir, "data");
  if (!opts.dir || opts.data) writeData(dataDir, opts.data ?? defaultData());
  const clockFile = join(dir, "clock.json");
  const setNow = (ms: number) => writeClock(clockFile, new Date(ms));
  if (opts.now !== undefined || !opts.dir) setNow(opts.now ?? T0);
  const config = loadConfig({
    BACKTESTER_DATA_DIR: dataDir,
    BACKTESTER_CLOCK_FILE: clockFile,
    BACKTESTER_STATE_DIR: join(dir, "state"),
    BACKTESTER_TRADING_ENABLED: "true",
    BACKTESTER_SLIPPAGE_TICKS: "1",
    ...opts.env,
  });
  const exchange = new ReplayExchange(config);
  const journal = new Journal(config.journalPath, () => exchange.now());
  const deps: Deps = { config, client: exchange, journal };
  const server = createServer(deps);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const text = res.content[0].text;
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { isError: !!res.isError, text, data };
  };
  return { dir, dataDir, config, exchange, journal, client, call, setNow };
}

export const RATIONALE = "setup:test breakout, stop 20 ticks below, target 40 ticks, risk $10";
