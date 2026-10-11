/**
 * Thin wrapper around the official TypeSafe SDK.
 *
 * Every module talks to Jev through this class so that timeouts, retries, logging,
 * cost accounting, and error wording stay consistent across tools.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  type EntryType,
  type Logger,
  type ModelCard,
  type Questions,
  type SystemOneResult
} from "@typesafe-ai/sdk";
import type { Config } from "../config.js";

/** Jev 1.13 list price: input tokens only; output tokens are free. See https://docs.typesafe.ai/models */
export const JEV_USD_PER_MTOK_INPUT = 0.042;

export interface JevCall<Q extends Questions> {
  result: SystemOneResult<Q>;
  latencyMs: number;
  /** Estimated request cost in USD from list price. */
  costUsd: number;
}

/** stdout is the MCP protocol channel, so SDK logging must go to stderr. */
const stderrLogger: Logger = {
  debug: (message, ...args) => console.error("[typesafe]", message, ...args),
  info: (message, ...args) => console.error("[typesafe]", message, ...args),
  warn: (message, ...args) => console.error("[typesafe]", message, ...args),
  error: (message, ...args) => console.error("[typesafe]", message, ...args)
};

export class JevClient {
  readonly defaultModel: string;
  readonly #client: TypeSafeClient;

  constructor(config: Config) {
    this.defaultModel = config.model;
    this.#client = new TypeSafeClient({
      apiKey: config.apiKey,
      defaultModel: config.model,
      timeout: config.timeoutMs,
      retry: { maxRetries: config.maxRetries },
      logger: stderrLogger
    });
  }

  /** Evaluate typed questions against one state in a single request. */
  async ask<const Q extends Questions>(
    state: EntryType,
    questions: Q,
    options: { model?: string; signal?: AbortSignal } = {}
  ): Promise<JevCall<Q>> {
    const started = performance.now();
    const result = await this.#client.systemOne(
      { state, questions, ...(options.model ? { model: options.model } : {}) },
      options.signal ? { signal: options.signal } : {}
    );
    return {
      result,
      latencyMs: Math.round(performance.now() - started),
      costUsd: (result.usage.input_tokens / 1_000_000) * JEV_USD_PER_MTOK_INPUT
    };
  }

  async listModels(): Promise<ModelCard[]> {
    return this.#client.models.list();
  }
}

/** Turn any failure from the SDK into a short, actionable sentence for an agent to read. */
export function describeJevError(error: unknown): string {
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return `Jev rejected the API key (HTTP ${error.status}). Check that JEV_ASSIST holds a valid TypeSafe key, then restart the MCP server.`;
  }
  if (error instanceof UnprocessableEntityError) {
    return `Jev rejected the request as invalid (HTTP 422): ${summarizeBody(error.body)}. Fix the question shapes and retry.`;
  }
  if (error instanceof RateLimitError) {
    return "Jev rate limit exceeded (HTTP 429) after retries. Wait a few seconds and retry, or send fewer requests in parallel.";
  }
  if (error instanceof APIError) {
    const overloaded = error.status === 529 ? " (TypeSafe is overloaded)" : "";
    return `Jev request failed with HTTP ${error.status}${overloaded}: ${summarizeBody(error.body)}. Retry shortly.`;
  }
  if (error instanceof APITimeoutError) {
    return `Jev did not answer within ${error.timeoutMs} ms. Retry, or raise JEV_TIMEOUT_MS.`;
  }
  if (error instanceof APIConnectionError) {
    return `Could not reach the TypeSafe API (${error.message}). Check network access to api.typesafe.ai.`;
  }
  return `Unexpected error calling Jev: ${error instanceof Error ? error.message : String(error)}`;
}

function summarizeBody(body: unknown): string {
  if (body === undefined || body === null) return "no details";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
