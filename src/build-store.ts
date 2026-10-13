#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildStore, type BuildSummary } from "./storebuild.js";

/**
 * The store build CLI (`npm run build-store -- --from 202105 --to 202511`).
 * Reads the order-book parquet folder (--source, else BACKTESTER_ORDERBOOK_DIR)
 * and writes the store under BACKTESTER_DATA_DIR/derived/. Progress goes to
 * stderr; stdout stays empty.
 */

const USAGE =
  "usage: build-store --from YYYYMM --to YYYYMM [--source <folder with l1/ and l2/>] [--data-dir <BACKTESTER_DATA_DIR>] [--no-flow]";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

export async function runBuildStoreCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  log = (s: string) => process.stderr.write(`[build-store] ${s}\n`),
): Promise<BuildSummary> {
  const from = arg(argv, "--from");
  const to = arg(argv, "--to") ?? from;
  const source = arg(argv, "--source") ?? env.BACKTESTER_ORDERBOOK_DIR?.trim();
  const dataDir = arg(argv, "--data-dir") ?? env.BACKTESTER_DATA_DIR?.trim();
  if (!from || !to || !source || !dataDir) throw new Error(USAGE);
  return buildStore({ source, dataDir, from, to, log, flow: !argv.includes("--no-flow") });
}

const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

/* c8 ignore start */
if (invoked) {
  const envFile = process.env.BACKTESTER_ENV_FILE ?? ".env";
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  runBuildStoreCli(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`[build-store] ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    },
  );
}
/* c8 ignore stop */
