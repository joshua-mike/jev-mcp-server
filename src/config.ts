/**
 * Runtime configuration, read once from the environment.
 *
 * The API key comes from JEV_ASSIST (preferred) or TYPESAFE_API_KEY (the SDK's own name).
 */

export interface Config {
  apiKey: string;
  /** TypeSafe model or alias sent with every request unless a tool overrides it. */
  model: string;
  /** Per-attempt timeout for Jev requests, in milliseconds. */
  timeoutMs: number;
  /** Retries after the first attempt for retryable failures (429, 5xx, network). */
  maxRetries: number;
  /** Optional path to a JSON file that overrides parts of the default routing policy. */
  routingPolicyPath?: string;
  /** Optional path to a JSONL file; every routing decision is appended for later calibration. */
  routingLogPath?: string;
}

export class ConfigError extends Error {}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
  }
  return value;
}

function optionalPath(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

export function loadConfig(): Config {
  const apiKey = process.env.JEV_ASSIST?.trim() || process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "No TypeSafe API key found. Set the JEV_ASSIST environment variable (or TYPESAFE_API_KEY) " +
        "to a key from https://console.typesafe.ai and restart the server."
    );
  }
  return {
    apiKey,
    model: process.env.JEV_MODEL?.trim() || "jev-latest",
    timeoutMs: intFromEnv("JEV_TIMEOUT_MS", 8000, 500, 120_000),
    maxRetries: intFromEnv("JEV_MAX_RETRIES", 2, 0, 10),
    routingPolicyPath: optionalPath("JEV_ROUTER_POLICY"),
    routingLogPath: optionalPath("JEV_ROUTER_LOG")
  };
}
