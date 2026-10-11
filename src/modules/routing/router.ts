/**
 * Route one task: ask Jev the routing questions, apply the policy, and never leave the
 * caller without an answer. If Jev is unreachable the policy's fallback tier is returned
 * with status "degraded" so the agent can keep working.
 */

import { appendFile } from "node:fs/promises";
import * as z from "zod/v4";
import { describeJevError, type JevClient } from "../../jev/client.js";
import { decide, evaluateCondition, round, type RoutingSignals, type TierOverrides } from "./decide.js";
import { effortSchema, type RoutingPolicy } from "./policy.js";
import {
  buildRoutingQuestions,
  buildRoutingState,
  FLAG_NAMES,
  SCORE_NAMES,
  scoreMax,
  type RoutingInput,
  type RoutingQuestions
} from "./questions.js";
import type { SystemOneResult } from "@typesafe-ai/sdk";

const scoreSignalSchema = z.object({ score: z.number(), max: z.number(), confidence: z.number() });

export const routingDecisionSchema = z.object({
  id: z.string().optional().describe("Caller-supplied id (batch routing only)"),
  status: z
    .enum(["routed", "insufficient_context", "degraded"])
    .describe("routed: normal; insufficient_context: task needs history it lacks; degraded: Jev unavailable, fallback used"),
  tier: z.string(),
  label: z.string(),
  model: z.string().describe("Claude API model id"),
  claude_code_alias: z.string().describe("Pass as the Agent tool's `model` parameter"),
  effort: effortSchema,
  base_tier: z.string().nullable(),
  scores: z
    .object({ capability: z.number(), uncertainty: z.number(), effective: z.number() })
    .nullable()
    .describe("Composite 0-1 scores; null when degraded"),
  task_type: z.object({ choice: z.string(), confidence: z.number() }).nullable(),
  signals: z.record(z.string(), scoreSignalSchema).nullable().describe("Raw Jev Score answers"),
  flags: z.record(z.string(), z.number()).nullable().describe("Raw Jev Noul probabilities"),
  rules_applied: z.array(z.string()),
  warnings: z.array(z.string()),
  pricing: z.object({ input_usd_per_mtok: z.number(), output_usd_per_mtok: z.number() }),
  jev: z
    .object({ model: z.string(), input_tokens: z.number(), latency_ms: z.number(), cost_usd: z.number() })
    .nullable(),
  task_truncated: z.boolean(),
  error: z.string().optional()
});

export type RoutingDecision = z.infer<typeof routingDecisionSchema>;

export interface RouteOptions {
  overrides?: TierOverrides;
  logPath?: string;
  id?: string;
  signal?: AbortSignal;
}

export function extractSignals(result: SystemOneResult<RoutingQuestions>): RoutingSignals {
  const { answers } = result;
  const scores = Object.fromEntries(
    SCORE_NAMES.map((name) => {
      const answer = answers[name];
      return [name, { score: answer.score, max: scoreMax(name), confidence: answer.confidence }];
    })
  ) as RoutingSignals["scores"];
  const flags = Object.fromEntries(FLAG_NAMES.map((name) => [name, answers[name].noul])) as RoutingSignals["flags"];
  return {
    task_type: {
      choice: answers.task_type.choice,
      confidence: answers.task_type.confidence,
      probabilities: { ...answers.task_type.probabilities }
    },
    scores,
    flags
  };
}

export interface ScoredTask {
  signals: RoutingSignals;
  jev: NonNullable<RoutingDecision["jev"]>;
  truncated: boolean;
}

/** Ask Jev the routing questions for one task. Throws SDK errors; routeTask handles them. */
export async function scoreTask(jev: JevClient, input: RoutingInput, signal?: AbortSignal): Promise<ScoredTask> {
  const { state, truncated } = buildRoutingState(input);
  const call = await jev.ask(state, buildRoutingQuestions(Boolean(input.context?.trim())), { signal });
  return {
    signals: extractSignals(call.result),
    jev: {
      model: call.result.model,
      input_tokens: call.result.usage.input_tokens,
      latency_ms: call.latencyMs,
      cost_usd: round(call.costUsd, 7)
    },
    truncated
  };
}

/** Apply the policy to signals. Pure, so saved signals can be re-scored after policy changes. */
export function buildDecision(
  scored: { signals: RoutingSignals; jev: RoutingDecision["jev"]; truncated: boolean },
  policy: RoutingPolicy,
  options: { hasContext: boolean; overrides?: TierOverrides; id?: string }
): RoutingDecision {
  const { signals } = scored;
  const insufficientContext = !options.hasContext && evaluateCondition(policy.insufficient_context_when, signals);
  const core = decide(signals, policy, options.overrides, { insufficientContext });
  return {
    ...(options.id !== undefined ? { id: options.id } : {}),
    status: insufficientContext ? "insufficient_context" : "routed",
    tier: core.tier.id,
    label: core.tier.label,
    model: core.tier.model,
    claude_code_alias: core.tier.claude_code_alias,
    effort: core.effort,
    base_tier: core.base_tier,
    scores: { capability: core.capability, uncertainty: core.uncertainty, effective: core.effective },
    task_type: { choice: signals.task_type.choice, confidence: round(signals.task_type.confidence) },
    signals: Object.fromEntries(
      Object.entries(signals.scores).map(([k, v]) => [k, { score: round(v.score), max: v.max, confidence: round(v.confidence) }])
    ),
    flags: Object.fromEntries(Object.entries(signals.flags).map(([k, v]) => [k, round(v)])),
    rules_applied: core.rules_applied,
    warnings: core.warnings,
    pricing: { input_usd_per_mtok: core.tier.input_usd_per_mtok, output_usd_per_mtok: core.tier.output_usd_per_mtok },
    jev: scored.jev,
    task_truncated: scored.truncated
  };
}

export async function routeTask(
  jev: JevClient,
  policy: RoutingPolicy,
  input: RoutingInput,
  options: RouteOptions = {}
): Promise<RoutingDecision> {
  let decision: RoutingDecision;
  let signals: RoutingSignals | undefined;
  try {
    const scored = await scoreTask(jev, input, options.signal);
    signals = scored.signals;
    decision = buildDecision(scored, policy, {
      hasContext: Boolean(input.context?.trim()),
      overrides: options.overrides,
      id: options.id
    });
  } catch (error) {
    decision = degradedDecision(policy, describeJevError(error), buildRoutingState(input).truncated, options);
  }

  if (options.logPath) await logDecision(options.logPath, input, decision, signals);
  return decision;
}

function degradedDecision(policy: RoutingPolicy, error: string, truncated: boolean, options: RouteOptions): RoutingDecision {
  const tier = policy.tiers.find((t) => t.id === policy.fallback_tier)!;
  return {
    ...(options.id !== undefined ? { id: options.id } : {}),
    status: "degraded",
    tier: tier.id,
    label: tier.label,
    model: tier.model,
    claude_code_alias: tier.claude_code_alias,
    effort: "medium",
    base_tier: null,
    scores: null,
    task_type: null,
    signals: null,
    flags: null,
    rules_applied: [`fallback ${tier.id}: Jev unavailable`],
    warnings: ["Routing fell back to the policy default because Jev could not be reached; this is not a judged route."],
    pricing: { input_usd_per_mtok: tier.input_usd_per_mtok, output_usd_per_mtok: tier.output_usd_per_mtok },
    jev: null,
    task_truncated: truncated,
    error
  };
}

/** Append-only JSONL for calibration: compare logged routes with real outcomes, then tune the policy. */
async function logDecision(
  path: string,
  input: RoutingInput,
  decision: RoutingDecision,
  signals: RoutingSignals | undefined
): Promise<void> {
  const record = {
    ts: new Date().toISOString(),
    source: input.source,
    task: input.task.length > 500 ? `${input.task.slice(0, 500)}…` : input.task,
    has_context: Boolean(input.context?.trim()),
    status: decision.status,
    tier: decision.tier,
    effort: decision.effort,
    scores: decision.scores,
    signals: signals ?? null,
    rules_applied: decision.rules_applied,
    error: decision.error
  };
  try {
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error(`[jev-mcp] could not write routing log ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
