/**
 * The extension point: each capability built on Jev is a module that registers its own tools.
 *
 * To add a capability (guardrails, verification, reranking, ...), create a folder under
 * src/modules/, export a JevModule, and add it to MODULES in src/modules/index.ts.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Config } from "../config.js";
import type { JevClient } from "../jev/client.js";

export interface ModuleContext {
  jev: JevClient;
  config: Config;
}

export interface JevModule {
  /** Short identifier, used in logs and the README. */
  name: string;
  register(server: McpServer, context: ModuleContext): void;
}

/** Most tool results stay small; this caps pathological cases (huge batches, huge answer maps). */
export const CHARACTER_LIMIT = 25_000;

export const responseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("'markdown' for a compact human-readable summary (default) or 'json' for the full structured result");

export type ResponseFormat = z.infer<typeof responseFormatSchema>;

/** Build a tool result with both a text rendering and machine-readable structuredContent. */
export function toolResult<T extends Record<string, unknown>>(
  structured: T,
  format: ResponseFormat,
  renderMarkdown: (value: T) => string
): { content: { type: "text"; text: string }[]; structuredContent: T } {
  let text = format === "json" ? JSON.stringify(structured, null, 2) : renderMarkdown(structured);
  if (text.length > CHARACTER_LIMIT) {
    text = `${text.slice(0, CHARACTER_LIMIT)}\n\n[Truncated at ${CHARACTER_LIMIT} characters. Send fewer items per call to see everything.]`;
  }
  return { content: [{ type: "text", text }], structuredContent: structured };
}

export function errorResult(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}
