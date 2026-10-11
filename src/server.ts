/** Builds the MCP server and lets every module register its tools. */

import { McpServer } from "@modelcontextprotocol/server";
import { MODULES } from "./modules/index.js";
import type { ModuleContext } from "./modules/types.js";

export const SERVER_NAME = "jev-mcp-server";
export const SERVER_VERSION = "1.0.0";

export function createServer(context: ModuleContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Jev is TypeSafe's fast, low-cost judgment model. Before delegating work to a subagent, call jev_route_task " +
        "(or jev_route_tasks for several) with the exact subagent prompt and pass the returned claude_code_alias as the " +
        "Agent tool's model. Use jev_evaluate for other quick typed judgments (guardrails, verification, classification).",
      maxToolInputElements: 10_000
    }
  );
  for (const module of MODULES) module.register(server, context);
  return server;
}
