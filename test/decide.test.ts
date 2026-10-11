import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { decide, type RoutingSignals } from "../src/modules/routing/decide.js";
import { DEFAULT_POLICY, loadPolicy, PolicyError, validatePolicy, type RoutingPolicy } from "../src/modules/routing/policy.js";

type ScoreValues = Partial<Record<keyof RoutingSignals["scores"], number>>;

function signals(scores: ScoreValues = {}, flags: Partial<RoutingSignals["flags"]> = {}, confidence = 0.9): RoutingSignals {
  const s = (name: keyof RoutingSignals["scores"], max: number) => ({ score: scores[name] ?? 0, max, confidence });
  return {
    task_type: { choice: "feature", confidence: 0.8, probabilities: { feature: 0.9, conversation: 0 } },
    scores: {
      reasoning_depth: s("reasoning_depth", 4),
      scope: s("scope", 4),
      ambiguity: s("ambiguity", 3),
      domain_expertise: s("domain_expertise", 3),
      error_cost: s("error_cost", 3)
    },
    flags: {
      trivial: 0,
      security_sensitive: 0,
      destructive: 0,
      external_impact: 0,
      explicit_depth_request: 0,
      needs_prior_context: 0,
      ...flags
    }
  };
}

describe("decide", () => {
  it("routes an easy, safe task to the cheapest tier with low effort", () => {
    const d = decide(signals({ reasoning_depth: 0.3, scope: 1 }), DEFAULT_POLICY);
    assert.equal(d.tier.id, "haiku");
    assert.equal(d.effort, "low");
  });

  it("routes a moderate feature to sonnet", () => {
    const d = decide(signals({ reasoning_depth: 1.6, scope: 2, ambiguity: 1, domain_expertise: 1 }), DEFAULT_POLICY);
    assert.equal(d.tier.id, "sonnet");
    assert.equal(d.effort, "medium");
  });

  it("routes deep, specialized, open-ended work to the top tier", () => {
    const d = decide(signals({ reasoning_depth: 3.8, scope: 3.5, ambiguity: 2.5, domain_expertise: 2.8 }), DEFAULT_POLICY);
    assert.equal(d.tier.id, "fable");
    assert.equal(d.effort, "xhigh");
  });

  it("pushes a borderline task up a tier when Jev is unsure", () => {
    const borderline = { reasoning_depth: 1.9, scope: 2.2, ambiguity: 1.5, domain_expertise: 1.6 };
    assert.equal(decide(signals(borderline, {}, 0.95), DEFAULT_POLICY).tier.id, "sonnet");
    assert.equal(decide(signals(borderline, {}, 0.2), DEFAULT_POLICY).tier.id, "opus");
  });

  it("applies the severe error-cost floor regardless of capability and raises effort", () => {
    const d = decide(signals({ reasoning_depth: 0.5, error_cost: 2.8 }), DEFAULT_POLICY);
    assert.equal(d.tier.id, "opus");
    assert.equal(d.effort, "high");
    assert.ok(d.rules_applied.some((r) => r.includes("severe_error_cost")));
  });

  it("lets the trivial ceiling lower the tier, but a risk floor wins over it", () => {
    const easy = { reasoning_depth: 0.8, scope: 1, ambiguity: 1, domain_expertise: 1.5 };
    assert.equal(decide(signals(easy), DEFAULT_POLICY).tier.id, "sonnet");
    assert.equal(decide(signals(easy, { trivial: 0.9 }), DEFAULT_POLICY).tier.id, "haiku");
    const risky = decide(signals(easy, { trivial: 0.9, destructive: 0.8 }), DEFAULT_POLICY);
    assert.equal(risky.tier.id, "sonnet");
    assert.equal(risky.effort, "medium");
  });

  it("routes conversation to haiku via the task_type ceiling", () => {
    const s = signals({ reasoning_depth: 0.2, ambiguity: 3, domain_expertise: 2 });
    assert.equal(decide(s, DEFAULT_POLICY).tier.id, "sonnet");
    s.task_type = { choice: "conversation", confidence: 0.9, probabilities: { conversation: 0.95 } };
    assert.equal(decide(s, DEFAULT_POLICY).tier.id, "haiku");
  });

  it("uses the fallback tier when the task depends on missing context", () => {
    const d = decide(signals({ reasoning_depth: 0.2 }), DEFAULT_POLICY, {}, { insufficientContext: true });
    assert.equal(d.tier.id, DEFAULT_POLICY.fallback_tier);
    assert.equal(d.warnings.length, 1);
  });

  it("honors per-call bounds and warns when a cap undercuts the policy", () => {
    const hard = signals({ reasoning_depth: 3.8, scope: 3.5, ambiguity: 2.5, domain_expertise: 2.8 });
    const capped = decide(hard, DEFAULT_POLICY, { max_tier: "opus" });
    assert.equal(capped.tier.id, "opus");
    assert.match(capped.warnings[0] ?? "", /caps this task below/);
    assert.equal(decide(signals(), DEFAULT_POLICY, { min_tier: "sonnet" }).tier.id, "sonnet");
  });

  it("respects a global max_tier from the policy", () => {
    const policy: RoutingPolicy = { ...DEFAULT_POLICY, max_tier: "opus" };
    const d = decide(signals({ reasoning_depth: 4, scope: 4, ambiguity: 3, domain_expertise: 3 }), policy);
    assert.equal(d.tier.id, "opus");
    assert.equal(d.warnings.length, 0);
  });
});

describe("policy validation", () => {
  it("rejects thresholds that do not match the tier count", () => {
    assert.throws(() => validatePolicy({ ...DEFAULT_POLICY, thresholds: [0.3, 0.6] }), PolicyError);
  });

  it("rejects rules that reference unknown tiers or signals", () => {
    const badTier = { ...DEFAULT_POLICY, floors: [{ name: "x", when: { signal: "trivial", gte: 0.5 }, tier: "gpt" }] };
    assert.throws(() => validatePolicy(badTier), /Unknown tier "gpt"/);
    const badSignal = { ...DEFAULT_POLICY, floors: [{ name: "x", when: { signal: "vibes", gte: 0.5 }, tier: "opus" }] };
    assert.throws(() => validatePolicy(badSignal), /unknown signal "vibes"/);
  });

  it("merges an override file over the defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-policy-"));
    const path = join(dir, "policy.json");
    writeFileSync(path, JSON.stringify({ thresholds: [0.3, 0.6, 0.9], max_tier: "opus" }));
    const loaded = loadPolicy(path);
    assert.equal(loaded.source, path);
    assert.deepEqual(loaded.policy.thresholds, [0.3, 0.6, 0.9]);
    assert.equal(loaded.policy.max_tier, "opus");
    assert.deepEqual(loaded.policy.weights, DEFAULT_POLICY.weights);
  });

  it("reports an invalid override file clearly", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-policy-"));
    const path = join(dir, "policy.json");
    writeFileSync(path, JSON.stringify({ thresholds: "high" }));
    assert.throws(() => loadPolicy(path), /Invalid routing policy/);
  });
});
