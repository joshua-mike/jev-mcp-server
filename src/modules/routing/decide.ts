/**
 * Pure routing decision: Jev signals + policy -> tier and effort, with a readable trail.
 *
 * No I/O here, so the policy can be unit-tested and re-applied to logged signals offline.
 */

import { conditionSignals, EFFORTS, type Condition, type Effort, type RoutingPolicy, type Rule, type Tier } from "./policy.js";
import type { FlagName, ScoreName } from "./questions.js";

export interface ScoreSignal {
  score: number;
  max: number;
  confidence: number;
}

export interface RoutingSignals {
  task_type: { choice: string; confidence: number; probabilities: Record<string, number> };
  scores: Record<ScoreName, ScoreSignal>;
  flags: Record<FlagName, number>;
}

export interface TierOverrides {
  min_tier?: string;
  max_tier?: string;
}

export interface Decision {
  tier: Tier;
  effort: Effort;
  base_tier: string;
  /** Weighted, normalized Score average (0-1) before the uncertainty adjustment. */
  capability: number;
  /** Amount added because Jev was unsure; pushes borderline tasks up a tier. */
  uncertainty: number;
  /** capability + uncertainty, clamped to 0-1; this picks the base tier. */
  effective: number;
  rules_applied: string[];
  warnings: string[];
}

export function readSignal(signals: RoutingSignals, name: string): number | undefined {
  if (name.startsWith("task_type:")) return signals.task_type.probabilities[name.slice("task_type:".length)];
  if (name in signals.scores) return signals.scores[name as ScoreName].score;
  if (name in signals.flags) return signals.flags[name as FlagName];
  return undefined;
}

export function evaluateCondition(condition: Condition, signals: RoutingSignals): boolean {
  if ("all" in condition) return condition.all.every((c) => evaluateCondition(c, signals));
  if ("any" in condition) return condition.any.some((c) => evaluateCondition(c, signals));
  const value = readSignal(signals, condition.signal);
  if (value === undefined) return false;
  if (condition.gte !== undefined && value < condition.gte) return false;
  if (condition.lte !== undefined && value > condition.lte) return false;
  return true;
}

function describeRule(kind: "floor" | "ceiling", rule: Rule, signals: RoutingSignals): string {
  const values = conditionSignals(rule.when)
    .map((name) => `${name}=${round(readSignal(signals, name) ?? Number.NaN)}`)
    .join(", ");
  return `${kind} ${rule.tier} <- ${rule.name}${rule.reason ? `: ${rule.reason}` : ""} (${values})`;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function maxEffort(a: Effort, b: Effort): Effort {
  return EFFORTS.indexOf(a) >= EFFORTS.indexOf(b) ? a : b;
}

export function tierIndex(policy: RoutingPolicy, id: string): number {
  const index = policy.tiers.findIndex((t) => t.id === id);
  if (index < 0) throw new Error(`Unknown tier "${id}". Known tiers: ${policy.tiers.map((t) => t.id).join(", ")}.`);
  return index;
}

export function decide(
  signals: RoutingSignals,
  policy: RoutingPolicy,
  overrides: TierOverrides = {},
  options: { insufficientContext?: boolean } = {}
): Decision {
  const rules_applied: string[] = [];
  const warnings: string[] = [];

  // 1. Composite capability score from the weighted, normalized Scores.
  const dims = Object.entries(policy.weights) as [keyof RoutingPolicy["weights"], number][];
  const totalWeight = dims.reduce((sum, [, w]) => sum + w, 0) || 1;
  let capability = 0;
  let meanConfidence = 0;
  for (const [name, weight] of dims) {
    const s = signals.scores[name];
    capability += (weight * s.score) / s.max;
    meanConfidence += weight * s.confidence;
  }
  capability /= totalWeight;
  meanConfidence /= totalWeight;
  const uncertainty = policy.uncertainty_penalty * (1 - meanConfidence);
  const effective = Math.min(1, Math.max(0, capability + uncertainty));

  // 2. Base tier: how many thresholds the effective score reaches.
  const baseIndex = policy.thresholds.filter((t) => effective >= t).length;
  let index = baseIndex;
  rules_applied.push(
    `base ${policy.tiers[baseIndex]!.id}: effective ${round(effective)} = capability ${round(capability)} + uncertainty ${round(uncertainty)}`
  );

  // 3. Ceilings, then floors (a fired floor always wins over a ceiling).
  for (const rule of policy.ceilings) {
    if (!evaluateCondition(rule.when, signals)) continue;
    const ceiling = tierIndex(policy, rule.tier);
    if (ceiling < index) {
      index = ceiling;
      rules_applied.push(describeRule("ceiling", rule, signals));
    }
  }
  let effortFloor: Effort = "low";
  for (const rule of policy.floors) {
    if (!evaluateCondition(rule.when, signals)) continue;
    const floor = tierIndex(policy, rule.tier);
    if (rule.effort_at_least) effortFloor = maxEffort(effortFloor, rule.effort_at_least);
    if (floor > index) {
      index = floor;
      rules_applied.push(describeRule("floor", rule, signals));
    } else if (rule.effort_at_least) {
      rules_applied.push(`${describeRule("floor", rule, signals)} [tier already met; effort >= ${rule.effort_at_least}]`);
    }
  }

  // 4. A task that only makes sense with missing conversation history cannot be judged; be safe.
  if (options.insufficientContext) {
    const fallback = tierIndex(policy, policy.fallback_tier);
    if (fallback > index) index = fallback;
    rules_applied.push(`fallback >= ${policy.fallback_tier}: task depends on earlier conversation that was not provided`);
    warnings.push("The task refers to earlier conversation. Pass `context` describing the work for an accurate route.");
  }

  // 5. Global policy bounds, then per-call bounds. Per-call bounds win but are flagged.
  index = clampIndex(index, policy, policy.min_tier, policy.max_tier, "policy", rules_applied);
  const beforeCaller = index;
  index = clampIndex(index, policy, overrides.min_tier, overrides.max_tier, "caller", rules_applied);
  if (index < beforeCaller) {
    warnings.push(
      `max_tier=${overrides.max_tier} caps this task below the ${policy.tiers[beforeCaller]!.id} tier the policy chose; expect lower accuracy.`
    );
  }

  // 6. Effort tracks how much thinking the task needs (tier tracks how capable the model must be),
  //    raised by any fired floor's minimum.
  const depth = signals.scores.reasoning_depth.score;
  const { medium, high, xhigh } = policy.effort_thresholds;
  const depthEffort: Effort = depth >= xhigh ? "xhigh" : depth >= high ? "high" : depth >= medium ? "medium" : "low";
  const effort = maxEffort(depthEffort, effortFloor);

  return {
    tier: policy.tiers[index]!,
    effort,
    base_tier: policy.tiers[baseIndex]!.id,
    capability: round(capability, 3),
    uncertainty: round(uncertainty, 3),
    effective: round(effective, 3),
    rules_applied,
    warnings
  };
}

function clampIndex(
  index: number,
  policy: RoutingPolicy,
  minTier: string | undefined,
  maxTier: string | undefined,
  label: "policy" | "caller",
  trail: string[]
): number {
  let result = index;
  if (minTier !== undefined) {
    const min = tierIndex(policy, minTier);
    if (result < min) {
      result = min;
      trail.push(`${label} min_tier -> ${minTier}`);
    }
  }
  if (maxTier !== undefined) {
    const max = tierIndex(policy, maxTier);
    if (result > max) {
      result = max;
      trail.push(`${label} max_tier -> ${maxTier}`);
    }
  }
  return result;
}
