/**
 * Routing eval: route every labeled case and report accuracy, under/over-routing, and cost.
 *
 *   npm run eval:routing                                   # live: one Jev call per case
 *   npm run eval:routing -- --save eval/signals.json       # live, and keep Jev's raw signals
 *   npm run eval:routing -- --replay eval/signals.json     # no Jev calls: re-apply the current policy
 *   npm run eval:routing -- --verbose                      # also print every case's rules
 *
 * Replay is how to tune thresholds: Jev's judgments do not change when the policy does.
 * Set JEV_ROUTER_POLICY to try an override file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { JevClient } from "../src/jev/client.js";
import { tierIndex } from "../src/modules/routing/decide.js";
import { loadPolicy } from "../src/modules/routing/policy.js";
import type { TaskSource } from "../src/modules/routing/questions.js";
import { buildDecision, scoreTask, type RoutingDecision, type ScoredTask } from "../src/modules/routing/router.js";

interface Case {
  id: string;
  task: string;
  context?: string;
  source?: TaskSource;
  expected: string;
  acceptable?: string[];
  expect_status?: RoutingDecision["status"];
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const savePath = flag("--save");
const replayPath = flag("--replay");
const verbose = args.includes("--verbose");
const casesPath = flag("--cases") ?? "eval/routing-cases.json";

const { cases } = JSON.parse(readFileSync(casesPath, "utf8")) as { cases: Case[] };
const loaded = loadPolicy(process.env.JEV_ROUTER_POLICY);
const { policy } = loaded;

async function scoreAll(): Promise<Record<string, ScoredTask>> {
  if (replayPath) return JSON.parse(readFileSync(replayPath, "utf8")) as Record<string, ScoredTask>;
  const jev = new JevClient(loadConfig());
  const scored: Record<string, ScoredTask> = {};
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < cases.length) {
        const c = cases[next++]!;
        scored[c.id] = await scoreTask(jev, { task: c.task, context: c.context, source: c.source ?? "subagent_task" });
      }
    })
  );
  if (savePath) writeFileSync(savePath, JSON.stringify(scored, null, 2));
  return scored;
}

const scored = await scoreAll();
const opus = policy.tiers.find((t) => t.id === "opus") ?? policy.tiers[policy.tiers.length - 1]!;

let exact = 0;
let acceptable = 0;
let under = 0;
let over = 0;
let statusMismatch = 0;
let routedCost = 0;
let expectedCost = 0;
let jevCost = 0;
let jevLatency = 0;
const confusion: Record<string, Record<string, number>> = {};
const rows: string[] = [];

for (const c of cases) {
  const s = scored[c.id];
  if (!s) throw new Error(`No signals for case ${c.id}; re-run without --replay.`);
  const d = buildDecision(s, policy, { hasContext: Boolean(c.context?.trim()) });
  const ok = new Set([c.expected, ...(c.acceptable ?? [])]);
  const lowestOk = Math.min(...[...ok].map((t) => tierIndex(policy, t)));
  const highestOk = Math.max(...[...ok].map((t) => tierIndex(policy, t)));
  const got = tierIndex(policy, d.tier);

  if (d.tier === c.expected) exact++;
  let verdict = "ok";
  if (ok.has(d.tier)) acceptable++;
  else if (got < lowestOk) {
    under++;
    verdict = "UNDER";
  } else if (got > highestOk) {
    over++;
    verdict = "over";
  }
  if (c.expect_status && c.expect_status !== d.status) {
    statusMismatch++;
    verdict += " (status)";
  }

  confusion[c.expected] ??= {};
  confusion[c.expected]![d.tier] = (confusion[c.expected]![d.tier] ?? 0) + 1;
  routedCost += policy.tiers[got]!.input_usd_per_mtok;
  expectedCost += policy.tiers[tierIndex(policy, c.expected)]!.input_usd_per_mtok;
  jevCost += s.jev.cost_usd;
  jevLatency += s.jev.latency_ms;

  rows.push(
    `${verdict.padEnd(14)} ${c.id.padEnd(24)} expected ${c.expected.padEnd(6)} got ${d.tier.padEnd(6)} ${d.effort.padEnd(6)} eff=${d.scores?.effective.toFixed(2)} ${d.task_type?.choice ?? ""}`
  );
  if (verbose) rows.push(...d.rules_applied.map((r) => `    ${r}`));
}

const n = cases.length;
const pct = (x: number) => `${((100 * x) / n).toFixed(0)}%`;
console.log(`Policy: ${loaded.source} · cases: ${n} · signals: ${replayPath ? `replayed from ${replayPath}` : "live Jev calls"}\n`);
console.log(rows.join("\n"));
console.log(`\nExact tier match:      ${exact}/${n} (${pct(exact)})`);
console.log(`Within acceptable set: ${acceptable}/${n} (${pct(acceptable)})`);
console.log(`Under-routed (risk):   ${under}   Over-routed (cost): ${over}   Status mismatches: ${statusMismatch}`);
console.log(
  `Input-price index: routed ${(routedCost / n).toFixed(2)} $/MTok vs labels ${(expectedCost / n).toFixed(2)} vs all-${opus.id} ${opus.input_usd_per_mtok.toFixed(2)}` +
    ` -> ${(100 * (1 - routedCost / (n * opus.input_usd_per_mtok))).toFixed(0)}% cheaper than all-${opus.id}`
);
if (!replayPath) console.log(`Jev: total ~$${jevCost.toFixed(5)}, mean latency ${(jevLatency / n).toFixed(0)} ms per task`);
console.log("\nConfusion (rows = expected, cols = routed):");
const ids = policy.tiers.map((t) => t.id);
console.log(`${"".padEnd(8)}${ids.map((t) => t.padEnd(8)).join("")}`);
for (const e of ids) console.log(`${e.padEnd(8)}${ids.map((t) => String(confusion[e]?.[t] ?? 0).padEnd(8)).join("")}`);
