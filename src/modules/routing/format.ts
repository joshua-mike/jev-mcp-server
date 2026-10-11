/** Compact Markdown renderings of routing results, sized for an agent's context window. */

import type { LoadedPolicy } from "./policy.js";
import type { RoutingDecision } from "./router.js";

const STATUS_NOTES: Record<RoutingDecision["status"], string> = {
  routed: "",
  insufficient_context: " — ⚠ task depends on missing conversation history; pass `context` for a judged route",
  degraded: " — ⚠ Jev unavailable; policy fallback, not a judged route"
};

export function renderDecision(d: RoutingDecision): string {
  const lines = [
    `**${d.id ? `[${d.id}] ` : ""}Route: ${d.tier}** — ${d.label} (\`${d.model}\`), effort **${d.effort}**${STATUS_NOTES[d.status]}`,
    `Agent tool: \`model: "${d.claude_code_alias}"\``
  ];
  if (d.scores && d.task_type) {
    lines.push(
      `Task type: ${d.task_type.choice} (conf ${d.task_type.confidence}) · capability ${d.scores.capability} + uncertainty ${d.scores.uncertainty} = ${d.scores.effective}`
    );
  }
  if (d.signals) {
    lines.push(
      `Scores: ${Object.entries(d.signals)
        .map(([name, s]) => `${name} ${s.score}/${s.max} (c${s.confidence})`)
        .join(" · ")}`
    );
  }
  if (d.flags) {
    lines.push(
      `Flags P(yes): ${Object.entries(d.flags)
        .map(([name, p]) => `${name} ${p}`)
        .join(" · ")}`
    );
  }
  lines.push("Rules:", ...d.rules_applied.map((r) => `- ${r}`));
  if (d.warnings.length) lines.push(...d.warnings.map((w) => `⚠ ${w}`));
  if (d.error) lines.push(`Error: ${d.error}`);
  if (d.task_truncated) lines.push("Note: the task text was long and was truncated before scoring.");
  if (d.jev) {
    lines.push(`Jev: ${d.jev.model}, ${d.jev.latency_ms} ms, ${d.jev.input_tokens} input tokens (~$${d.jev.cost_usd.toFixed(6)})`);
  }
  return lines.join("\n");
}

export interface BatchSummary {
  count: number;
  by_tier: Record<string, number>;
  degraded: number;
  insufficient_context: number;
  total_jev_cost_usd: number;
}

export function renderBatch(result: { summary: BatchSummary; decisions: RoutingDecision[] }): string {
  const { summary } = result;
  const tiers = Object.entries(summary.by_tier)
    .map(([tier, n]) => `${tier}: ${n}`)
    .join(", ");
  const header = [
    `# Routed ${summary.count} task(s) — ${tiers}`,
    summary.degraded ? `⚠ ${summary.degraded} degraded (Jev unavailable; fallback tier used)` : "",
    summary.insufficient_context ? `⚠ ${summary.insufficient_context} need conversation context` : "",
    `Jev cost: ~$${summary.total_jev_cost_usd.toFixed(6)}`
  ].filter(Boolean);
  const rows = result.decisions.map(
    (d, i) =>
      `| ${d.id ?? i + 1} | ${d.tier} | ${d.effort} | ${d.task_type?.choice ?? "—"} | ${d.scores?.effective ?? "—"} | ${d.status} |`
  );
  return [
    ...header,
    "",
    "| id | tier | effort | type | score | status |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "Pass each task's tier as the Agent tool `model`. Call jev_route_task on one task to see its full signals."
  ].join("\n");
}

export function renderPolicy(loaded: LoadedPolicy): string {
  const { policy } = loaded;
  const bounds = [0, ...policy.thresholds, 1];
  const tierRows = policy.tiers.map(
    (t, i) =>
      `| ${t.id} | ${t.label} | \`${t.model}\` | ${t.claude_code_alias} | ${bounds[i]}–${bounds[i + 1]} | $${t.input_usd_per_mtok} / $${t.output_usd_per_mtok} |`
  );
  const rule = (r: { name: string; tier: string; reason?: string; when: unknown; effort_at_least?: string }) =>
    `- **${r.name}** → ${r.tier}${r.effort_at_least ? ` (effort ≥ ${r.effort_at_least})` : ""}: ${r.reason ?? ""} — \`${JSON.stringify(r.when)}\``;
  return [
    `# Routing policy (${loaded.source})`,
    "",
    "| tier | model | id | Claude Code alias | effective score | $ in / out per MTok |",
    "|---|---|---|---|---|---|",
    ...tierRows,
    "",
    `Capability weights: ${Object.entries(policy.weights)
      .map(([k, w]) => `${k} ${w}`)
      .join(", ")}`,
    `Uncertainty penalty: ${policy.uncertainty_penalty} × (1 − weighted mean confidence)`,
    `Effort from reasoning_depth (0–4): medium ≥ ${policy.effort_thresholds.medium}, high ≥ ${policy.effort_thresholds.high}, xhigh ≥ ${policy.effort_thresholds.xhigh}`,
    `Fallback tier: ${policy.fallback_tier} (Jev unavailable, or no context and \`${JSON.stringify(policy.insufficient_context_when)}\`)` +
      (policy.min_tier ? ` · min_tier ${policy.min_tier}` : "") +
      (policy.max_tier ? ` · max_tier ${policy.max_tier}` : ""),
    "",
    "Floors (raise the tier; always win over ceilings):",
    ...policy.floors.map(rule),
    "",
    "Ceilings (lower the tier):",
    ...policy.ceilings.map(rule),
    "",
    "Override any top-level key with a JSON file named by JEV_ROUTER_POLICY."
  ].join("\n");
}
