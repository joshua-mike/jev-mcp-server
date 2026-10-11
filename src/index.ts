#!/usr/bin/env node
/** jev-mcp-server: stdio entry point for Claude Code and other local MCP hosts. */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigError, loadConfig } from "./config.js";
import { JevClient } from "./jev/client.js";
import { MODULES } from "./modules/index.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.error(
      `${SERVER_NAME} ${SERVER_VERSION}: MCP server (stdio) for TypeSafe's Jev model.\n` +
        "Env: JEV_ASSIST (API key, required), JEV_MODEL, JEV_TIMEOUT_MS, JEV_MAX_RETRIES, JEV_ROUTER_POLICY, JEV_ROUTER_LOG"
    );
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[${SERVER_NAME}] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const context = { config, jev: new JevClient(config) };
  void serveStdio(() => createServer(context));
  console.error(
    `[${SERVER_NAME}] running on stdio (model ${config.model}; modules: ${MODULES.map((m) => m.name).join(", ")})`
  );
}

main();
