#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ReplayExchange } from "./client.js";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { Journal } from "./journal.js";
import { createServer, type Deps } from "./server.js";

// stdout carries the MCP protocol in stdio mode, so all diagnostics go to stderr.
const log = (...args: unknown[]) => console.error("[backtester-mcp]", ...args);

function buildDeps(): Deps {
  const config = loadConfig();
  const client = new ReplayExchange(config);
  return { config, client, journal: new Journal(config.journalPath, () => client.now()) };
}

async function main() {
  const envFile = process.env.BACKTESTER_ENV_FILE ?? ".env";
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const deps = buildDeps();
  const { config } = deps;
  const window = `${config.start !== null ? new Date(config.start).toISOString() : "-"} .. ${config.end !== null ? new Date(config.end).toISOString() : "-"}`;
  log(`trading ${config.tradingEnabled ? "ENABLED" : "disabled (read-only)"}; run ${config.runId} (${config.stateDir}); window ${window}; data ${config.dataDir}`);

  if (process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http") {
    const port = Number(process.env.PORT ?? 8787);
    const host = process.env.HOST ?? "127.0.0.1";
    const app = createHttpApp(deps, { authToken: process.env.MCP_HTTP_AUTH_TOKEN?.trim() || undefined }, log);
    await new Promise<void>((resolve) => app.listen(port, host, resolve));
    log(`Streamable HTTP MCP endpoint at http://${host}:${port}/mcp`);
  } else {
    await createServer(deps).connect(new StdioServerTransport());
  }

  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log(e instanceof Error ? e.message : e);
  process.exit(1);
});
