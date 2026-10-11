/**
 * Routing policy: everything that turns Jev's raw judgments into a tier lives here as data.
 *
 * Jev's answers stay reusable; thresholds, weights, and gates are tuned in code or in a JSON
 * override file (JEV_ROUTER_POLICY) without changing the questions or re-running inference.
 */

import { readFileSync, statSync } from "node:fs";
import * as z from "zod/v4";
import { isKnownSignal } from "./questions.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const effortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof effortSchema>;

export const tierSchema = z
  .object({
    id: z.string().min(1).describe("Short tier id used in rules and overrides, e.g. 'sonnet'"),
    label: z.string(),
    model: z.string().describe("Claude API model id"),
    claude_code_alias: z.string().describe("Value for the Claude Code Agent tool's `model` parameter"),
    input_usd_per_mtok: z.number().nonnegative(),
    output_usd_per_mtok: z.number().nonnegative()
  })
  .strict();
export type Tier = z.infer<typeof tierSchema>;

/**
 * A condition over routing signals. `signal` names a Score (compared in level units, e.g.
 * error_cost 0-3), a Noul flag (probability 0-1), or a task-type probability as
 * `task_type:<option>` (0-1).
 */
export type Condition =
  | { signal: string; gte?: number; lte?: number }
  | { all: Condition[] }
  | { any: Condition[] };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z
      .object({ signal: z.string().min(1), gte: z.number().optional(), lte: z.number().optional() })
      .strict()
      .refine((c) => c.gte !== undefined || c.lte !== undefined, "A signal condition needs gte or lte"),
    z.object({ all: z.array(conditionSchema).min(1) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1) }).strict()
  ])
);

export const ruleSchema = z
  .object({
    name: z.string().min(1),
    when: conditionSchema,
    tier: z.string().min(1),
    effort_at_least: effortSchema.optional(),
    reason: z.string().optional()
  })
  .strict();
export type Rule = z.infer<typeof ruleSchema>;

export const policySchema = z
  .object({
    tiers: z.array(tierSchema).min(1).describe("Ordered from cheapest to most capable"),
    weights: z
      .object({
        reasoning_depth: z.number().nonnegative(),
        scope: z.number().nonnegative(),
        ambiguity: z.number().nonnegative(),
        domain_expertise: z.number().nonnegative()
      })
      .strict()
      .describe("Relative weight of each normalized Score in the 0-1 capability score"),
    thresholds: z
      .array(z.number().min(0).max(1))
      .describe("Ascending capability cut points between consecutive tiers; length = tiers - 1"),
    uncertainty_penalty: z
      .number()
      .min(0)
      .max(1)
      .describe("Added to the capability score times (1 - weighted mean confidence); routes up when Jev is unsure"),
    effort_thresholds: z
      .object({ medium: z.number(), high: z.number(), xhigh: z.number() })
      .strict()
      .describe("reasoning_depth score (0-4) at which the suggested effort rises to each level; below medium is low"),
    floors: z.array(ruleSchema).describe("When a rule fires, the tier is raised to at least rule.tier"),
    ceilings: z.array(ruleSchema).describe("When a rule fires, the tier is lowered to at most rule.tier (floors win)"),
    insufficient_context_when: conditionSchema.describe(
      "When this holds and the caller passed no context, the task is treated as unjudgeable and gets fallback_tier"
    ),
    fallback_tier: z.string().describe("Tier used when Jev is unavailable or the task cannot be judged"),
    min_tier: z.string().optional().describe("Global lower bound, applied before per-call overrides"),
    max_tier: z.string().optional().describe("Global upper bound, e.g. to exclude the most expensive tier")
  })
  .strict();
export type RoutingPolicy = z.infer<typeof policySchema>;

/** List prices (USD per million tokens) as of 2026-10; see the Claude pricing page. */
export const DEFAULT_TIERS: Tier[] = [
  {
    id: "haiku",
    label: "Claude Haiku 5.5",
    model: "claude-haiku-5-5",
    claude_code_alias: "haiku",
    input_usd_per_mtok: 0.1,
    output_usd_per_mtok: 0.5
  },
  {
    id: "sonnet",
    label: "Claude Sonnet 5.5",
    model: "claude-sonnet-5-5",
    claude_code_alias: "sonnet",
    input_usd_per_mtok: 2,
    output_usd_per_mtok: 10
  },
  {
    id: "opus",
    label: "Claude Opus 5.5",
    model: "claude-opus-5-5",
    claude_code_alias: "opus",
    input_usd_per_mtok: 4,
    output_usd_per_mtok: 20
  },
  {
    id: "fable",
    label: "Claude Fable 5.1",
    model: "claude-fable-5-1",
    claude_code_alias: "fable",
    input_usd_per_mtok: 10,
    output_usd_per_mtok: 50
  }
];

export const DEFAULT_POLICY: RoutingPolicy = {
  tiers: DEFAULT_TIERS,
  weights: { reasoning_depth: 0.4, scope: 0.2, ambiguity: 0.15, domain_expertise: 0.25 },
  thresholds: [0.25, 0.55, 0.8],
  uncertainty_penalty: 0.1,
  effort_thresholds: { medium: 1.2, high: 2.2, xhigh: 3.2 },
  floors: [
    {
      name: "severe_error_cost",
      when: { signal: "error_cost", gte: 2.4 },
      tier: "opus",
      effort_at_least: "high",
      reason: "a subtle mistake could cause data loss, a security hole, or an outage"
    },
    {
      name: "security_with_reasoning",
      when: { all: [{ signal: "security_sensitive", gte: 0.5 }, { signal: "reasoning_depth", gte: 1.8 }] },
      tier: "opus",
      reason: "security-sensitive work that needs real reasoning"
    },
    {
      name: "moderate_error_cost",
      when: { signal: "error_cost", gte: 1.6 },
      tier: "sonnet",
      reason: "mistakes could be subtle or costly"
    },
    {
      name: "security_sensitive",
      when: { all: [{ signal: "security_sensitive", gte: 0.5 }, { signal: "trivial", lte: 0.8 }] },
      tier: "sonnet",
      effort_at_least: "medium",
      reason: "non-trivial work touching auth, secrets, personal data, or a vulnerability"
    },
    {
      name: "destructive",
      when: { signal: "destructive", gte: 0.5 },
      tier: "sonnet",
      effort_at_least: "medium",
      reason: "asks for a hard-to-undo change"
    },
    {
      name: "external_impact",
      when: { signal: "external_impact", gte: 0.5 },
      tier: "sonnet",
      reason: "acts outside the local working copy"
    },
    {
      name: "explicit_depth_request",
      when: { signal: "explicit_depth_request", gte: 0.6 },
      tier: "sonnet",
      effort_at_least: "high",
      reason: "the task asks for extra care or depth"
    }
  ],
  ceilings: [
    {
      name: "trivial",
      when: {
        all: [
          { signal: "trivial", gte: 0.8 },
          { signal: "reasoning_depth", lte: 1 },
          { signal: "scope", lte: 1.5 }
        ]
      },
      tier: "haiku",
      reason: "one short reply or one obvious edit"
    },
    {
      name: "low_reasoning_low_stakes",
      when: {
        all: [
          { signal: "reasoning_depth", lte: 0.8 },
          { signal: "domain_expertise", lte: 0.8 },
          { signal: "error_cost", lte: 0.8 }
        ]
      },
      tier: "haiku",
      reason: "little reasoning and harmless if wrong, however broad"
    },
    {
      name: "conversation",
      when: { signal: "task_type:conversation", gte: 0.7 },
      tier: "haiku",
      reason: "no work requested"
    }
  ],
  insufficient_context_when: {
    all: [
      { signal: "needs_prior_context", gte: 0.6 },
      { signal: "trivial", lte: 0.6 }
    ]
  },
  fallback_tier: "opus"
};

export class PolicyError extends Error {}

/** Validate cross-field invariants zod cannot express alone. */
export function validatePolicy(policy: RoutingPolicy): RoutingPolicy {
  const ids = new Set(policy.tiers.map((t) => t.id));
  if (ids.size !== policy.tiers.length) throw new PolicyError("Tier ids must be unique.");
  if (policy.thresholds.length !== policy.tiers.length - 1) {
    throw new PolicyError(
      `thresholds must have exactly ${policy.tiers.length - 1} entries (one per boundary between ${policy.tiers.length} tiers).`
    );
  }
  for (let i = 1; i < policy.thresholds.length; i++) {
    if (policy.thresholds[i]! <= policy.thresholds[i - 1]!) throw new PolicyError("thresholds must be strictly ascending.");
  }
  const { medium, high, xhigh } = policy.effort_thresholds;
  if (!(medium <= high && high <= xhigh)) throw new PolicyError("effort_thresholds must satisfy medium <= high <= xhigh.");
  const referenced = [
    policy.fallback_tier,
    policy.min_tier,
    policy.max_tier,
    ...policy.floors.map((r) => r.tier),
    ...policy.ceilings.map((r) => r.tier)
  ].filter((id): id is string => id !== undefined);
  for (const id of referenced) {
    if (!ids.has(id)) throw new PolicyError(`Unknown tier "${id}". Known tiers: ${[...ids].join(", ")}.`);
  }
  const conditions = [
    ...[...policy.floors, ...policy.ceilings].map((rule) => ({ name: `Rule "${rule.name}"`, when: rule.when })),
    { name: "insufficient_context_when", when: policy.insufficient_context_when }
  ];
  for (const { name, when } of conditions) {
    for (const signal of conditionSignals(when)) {
      if (!isKnownSignal(signal)) {
        throw new PolicyError(
          `${name} references unknown signal "${signal}". Use a Score name, a flag name, or task_type:<option>.`
        );
      }
    }
  }
  return policy;
}

/** Every signal name a condition reads, in order of appearance. */
export function conditionSignals(condition: Condition): string[] {
  if ("signal" in condition) return [condition.signal];
  const children = "all" in condition ? condition.all : condition.any;
  return [...new Set(children.flatMap(conditionSignals))];
}

export interface LoadedPolicy {
  policy: RoutingPolicy;
  /** "defaults" or the override file path. */
  source: string;
}

let cache: { path: string; mtimeMs: number; loaded: LoadedPolicy } | undefined;

/**
 * Return the active policy. An override file is shallow-merged over the defaults (each top-level
 * key replaces the default wholesale) and re-read whenever it changes, so thresholds can be tuned
 * while the server runs.
 */
export function loadPolicy(overridePath?: string): LoadedPolicy {
  if (!overridePath) return { policy: DEFAULT_POLICY, source: "defaults" };

  let mtimeMs: number;
  try {
    mtimeMs = statSync(overridePath).mtimeMs;
  } catch {
    throw new PolicyError(`JEV_ROUTER_POLICY points to "${overridePath}", which does not exist or cannot be read.`);
  }
  if (cache && cache.path === overridePath && cache.mtimeMs === mtimeMs) return cache.loaded;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(overridePath, "utf8"));
  } catch (error) {
    throw new PolicyError(`Could not parse ${overridePath} as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PolicyError(`${overridePath} must contain a JSON object.`);
  }
  const parsed = policySchema.safeParse({ ...DEFAULT_POLICY, ...(raw as Record<string, unknown>) });
  if (!parsed.success) {
    throw new PolicyError(`Invalid routing policy in ${overridePath}: ${z.prettifyError(parsed.error)}`);
  }
  const loaded = { policy: validatePolicy(parsed.data), source: overridePath };
  cache = { path: overridePath, mtimeMs, loaded };
  return loaded;
}

validatePolicy(DEFAULT_POLICY);
