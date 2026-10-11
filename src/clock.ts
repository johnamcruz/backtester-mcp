#!/usr/bin/env node
/**
 * The replay clock: the server's "now" is the replayed time, never the wall
 * clock. It comes from BACKTESTER_CLOCK_FILE, a small JSON file
 * `{ "now": "<ISO>" }` that the replay driver writes and advances, re-read on
 * every call; without the file, from BACKTESTER_NOW (a fixed time).
 *
 * Run as a CLI to drive the clock by hand (manual replays, tests):
 *
 *   node dist/clock.js --file clock.json                 print the clock
 *   node dist/clock.js --file clock.json --set 2024-03-04T14:30:00Z
 *   node dist/clock.js --file clock.json --step 5        advance 5 minutes
 *   node dist/clock.js --file clock.json --next-bar 5    advance to the next 5-minute bar close
 *
 * --file defaults to BACKTESTER_CLOCK_FILE.
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export interface ClockSource {
  clockFile: string | null;
  fixedNow: string | null;
}

/** The replay time: the clock file's `now`, else BACKTESTER_NOW. Throws with a clear reason. */
export function readNow(src: ClockSource): Date {
  if (src.clockFile) {
    let text: string | null = null;
    try {
      text = readFileSync(src.clockFile, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (text !== null) {
      let now: unknown;
      try {
        now = (JSON.parse(text) as { now?: unknown }).now;
      } catch {
        throw new Error(`Replay clock ${src.clockFile} is not JSON: expected { "now": "<ISO time>" }.`);
      }
      const ms = typeof now === "string" ? Date.parse(now) : NaN;
      if (!Number.isFinite(ms)) throw new Error(`Replay clock ${src.clockFile} has no valid "now" (ISO time).`);
      return new Date(ms);
    }
    if (!src.fixedNow) throw new Error(`Replay clock ${src.clockFile} does not exist yet: the replay driver writes { "now": "<ISO time>" } there.`);
  }
  if (src.fixedNow) return new Date(Date.parse(src.fixedNow));
  throw new Error("No replay clock: set BACKTESTER_CLOCK_FILE or BACKTESTER_NOW.");
}

/** Write the clock atomically (a reader never sees a half-written file). */
export function writeClock(file: string, now: Date): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ now: now.toISOString() }) + "\n");
  renameSync(tmp, file);
}

export function stepClock(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60000);
}

/** The next close of a `tfMinutes` bar strictly after `now` (bars aligned to UTC multiples of the timeframe). */
export function nextBarClose(now: Date, tfMinutes: number): Date {
  const size = tfMinutes * 60000;
  return new Date((Math.floor(now.getTime() / size) + 1) * size);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const positive = (s: string | undefined, name: string) => {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} needs a positive number of minutes, got "${s}"`);
  return n;
};

/** The clock CLI. Returns the exit code; prints `{ "now": ... }`. */
export function runClockCli(argv: string[], env: Record<string, string | undefined> = process.env, out = (s: string) => process.stdout.write(s)): number {
  const file = arg(argv, "--file") ?? env.BACKTESTER_CLOCK_FILE?.trim();
  if (!file) throw new Error("usage: clock.js --file <clock.json> [--set <ISO> | --step <minutes> | --next-bar <minutes>]");
  const set = arg(argv, "--set");
  const step = arg(argv, "--step");
  const next = arg(argv, "--next-bar");
  if ([set, step, next].filter((x) => x !== undefined).length > 1) throw new Error("use only one of --set, --step, --next-bar");
  let now: Date;
  if (set !== undefined) {
    const ms = Date.parse(set);
    if (!Number.isFinite(ms)) throw new Error(`--set needs an ISO time, got "${set}"`);
    now = new Date(ms);
  } else {
    const current = readNow({ clockFile: file, fixedNow: null });
    if (step !== undefined) now = stepClock(current, positive(step, "--step"));
    else if (next !== undefined) now = nextBarClose(current, positive(next, "--next-bar"));
    else {
      out(JSON.stringify({ now: current.toISOString() }) + "\n");
      return 0;
    }
  }
  writeClock(file, now);
  out(JSON.stringify({ now: now.toISOString() }) + "\n");
  return 0;
}

const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invoked) {
  try {
    process.exit(runClockCli(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`[backtester-clock] ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
}
