/** Routing module: Jev-scored dynamic model routing across Claude tiers. */

import * as z from "zod/v4";
import { errorResult, responseFormatSchema, toolResult, type JevModule } from "../types.js";
import { renderBatch, renderDecision, renderPolicy, type BatchSummary } from "./format.js";
import { loadPolicy, PolicyError, policySchema, type LoadedPolicy } from "./policy.js";
import { routeTask, routingDecisionSchema, type RoutingDecision } from "./router.js";

const MAX_BATCH = 25;
const BATCH_CONCURRENCY = 6;

const sourceSchema = z
  .enum(["user_turn", "subagent_task"])
  .default("subagent_task")
  .describe(
    "'subagent_task' (default) for a self-contained prompt you are about to delegate; 'user_turn' for a message the user typed"
  );

const tierBoundSchema = (bound: "min" | "max") =>
  z
    .string()
    .optional()
    .describe(
      bound === "min"
        ? "Lowest tier allowed for this call (e.g. 'sonnet'). Tier ids come from jev_get_routing_policy."
        : "Highest tier allowed for this call, e.g. a budget cap like 'opus'. Capping below a risk floor adds a warning."
    );

const taskField = z
  .string()
  .min(1, "task must not be empty")
  .max(200_000)
  .describe("The exact prompt or message to be routed. Long text is truncated (head and tail kept) before scoring.");

const contextField = z
  .string()
  .max(20_000)
  .optional()
  .describe(
    "Optional background that changes how hard the task is: what 'it' refers to, relevant files, prior failures. Keep it short; only the first ~4,000 characters are used."
  );

const ROUTE_DESCRIPTION = `Score a task with Jev (TypeSafe's fast, low-cost System One model; one call takes about 150-500 ms and costs about $0.0001) and recommend the cheapest Claude tier that can do it without losing accuracy.

Jev rates reasoning depth, scope, ambiguity, domain expertise, and cost of error, and estimates the probability of risk flags (security-sensitive, destructive, external impact, trivial, explicit request for depth, depends on missing history). Code then applies a tunable policy: a weighted capability score picks the base tier, Jev's uncertainty pushes borderline tasks up, risk floors raise the tier, and trivial-task ceilings lower it.

When to use:
- Before delegating to a subagent: pass the exact prompt you will give the subagent as \`task\`, then call the Agent tool with \`model\` set to the returned \`claude_code_alias\` (haiku | sonnet | opus | fable).
- On a user's message (source='user_turn') to decide whether to answer directly or hand the work to a cheaper or stronger subagent.
- For several tasks at once, use jev_route_tasks instead.

Args:
- task (string): the prompt to route
- context (string, optional): short background, e.g. what "it" refers to
- source ('subagent_task' | 'user_turn', default 'subagent_task')
- min_tier / max_tier (string, optional): per-call bounds such as max_tier='opus'
- response_format ('markdown' | 'json', default 'markdown')

Returns: tier, model id, claude_code_alias, a suggested effort level (low | medium | high | xhigh), status, raw Jev signals with confidence, and the policy rules that fired.
- status 'insufficient_context': the task only makes sense with earlier conversation; the safe fallback tier was used. Retry with \`context\`.
- status 'degraded': Jev was unreachable; the policy fallback tier was returned (see \`error\`).`;

function checkTierBounds(loaded: LoadedPolicy, bounds: { min_tier?: string; max_tier?: string }): string | undefined {
  const ids = loaded.policy.tiers.map((t) => t.id);
  for (const [name, value] of Object.entries(bounds)) {
    if (value !== undefined && !ids.includes(value)) return `${name} "${value}" is not a tier. Valid tiers: ${ids.join(", ")}.`;
  }
  if (bounds.min_tier && bounds.max_tier && ids.indexOf(bounds.min_tier) > ids.indexOf(bounds.max_tier)) {
    return `min_tier "${bounds.min_tier}" is above max_tier "${bounds.max_tier}".`;
  }
  return undefined;
}

function loadPolicyOrError(path: string | undefined): LoadedPolicy | string {
  try {
    return loadPolicy(path);
  } catch (error) {
    if (error instanceof PolicyError) return `${error.message} Fix the file or unset JEV_ROUTER_POLICY.`;
    throw error;
  }
}

/** Run async work over items with a fixed number of workers, preserving input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarize(decisions: RoutingDecision[]): BatchSummary {
  const by_tier: Record<string, number> = {};
  for (const d of decisions) by_tier[d.tier] = (by_tier[d.tier] ?? 0) + 1;
  return {
    count: decisions.length,
    by_tier,
    degraded: decisions.filter((d) => d.status === "degraded").length,
    insufficient_context: decisions.filter((d) => d.status === "insufficient_context").length,
    total_jev_cost_usd: Number(decisions.reduce((sum, d) => sum + (d.jev?.cost_usd ?? 0), 0).toFixed(7))
  };
}

export const routingModule: JevModule = {
  name: "routing",
  register(server, { jev, config }) {
    server.registerTool(
      "jev_route_task",
      {
        title: "Route a task to a Claude tier",
        description: ROUTE_DESCRIPTION,
        inputSchema: z
          .object({
            task: taskField,
            context: contextField,
            source: sourceSchema,
            min_tier: tierBoundSchema("min"),
            max_tier: tierBoundSchema("max"),
            response_format: responseFormatSchema
          })
          .strict(),
        outputSchema: routingDecisionSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ task, context, source, min_tier, max_tier, response_format }, ctx) => {
        const loaded = loadPolicyOrError(config.routingPolicyPath);
        if (typeof loaded === "string") return errorResult(loaded);
        const boundsError = checkTierBounds(loaded, { min_tier, max_tier });
        if (boundsError) return errorResult(boundsError);

        const decision = await routeTask(
          jev,
          loaded.policy,
          { task, context, source },
          { overrides: { min_tier, max_tier }, logPath: config.routingLogPath, signal: ctx.mcpReq.signal }
        );
        return toolResult(decision, response_format, renderDecision);
      }
    );

    server.registerTool(
      "jev_route_tasks",
      {
        title: "Route several tasks to Claude tiers",
        description: `Route up to ${MAX_BATCH} independent tasks in one call (Jev requests run in parallel). Same scoring and policy as jev_route_task.

Use when planning a fan-out: route every subagent prompt at once, then launch each subagent with its returned \`claude_code_alias\` as the Agent tool \`model\`.

Args:
- tasks (array of {id?, task, context?}, 1-${MAX_BATCH}): the prompts to route; \`id\` is echoed back to match results
- source, min_tier, max_tier: applied to every task (see jev_route_task)
- response_format ('markdown' | 'json', default 'markdown'): markdown gives a summary table; json gives every task's full decision

Returns: { summary: { count, by_tier, degraded, insufficient_context, total_jev_cost_usd }, decisions: [...] } in input order.`,
        inputSchema: z
          .object({
            tasks: z
              .array(
                z
                  .object({
                    id: z.string().max(100).optional().describe("Your label for this task, echoed back"),
                    task: taskField,
                    context: contextField
                  })
                  .strict()
              )
              .min(1)
              .max(MAX_BATCH)
              .describe(`Tasks to route (max ${MAX_BATCH})`),
            source: sourceSchema,
            min_tier: tierBoundSchema("min"),
            max_tier: tierBoundSchema("max"),
            response_format: responseFormatSchema
          })
          .strict(),
        outputSchema: z.object({
          summary: z.object({
            count: z.number(),
            by_tier: z.record(z.string(), z.number()),
            degraded: z.number(),
            insufficient_context: z.number(),
            total_jev_cost_usd: z.number()
          }),
          decisions: z.array(routingDecisionSchema)
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ tasks, source, min_tier, max_tier, response_format }, ctx) => {
        const loaded = loadPolicyOrError(config.routingPolicyPath);
        if (typeof loaded === "string") return errorResult(loaded);
        const boundsError = checkTierBounds(loaded, { min_tier, max_tier });
        if (boundsError) return errorResult(boundsError);

        const decisions = await mapWithConcurrency(tasks, BATCH_CONCURRENCY, (item, index) =>
          routeTask(
            jev,
            loaded.policy,
            { task: item.task, context: item.context, source },
            {
              overrides: { min_tier, max_tier },
              logPath: config.routingLogPath,
              id: item.id ?? String(index + 1),
              signal: ctx.mcpReq.signal
            }
          )
        );
        return toolResult({ summary: summarize(decisions), decisions }, response_format, renderBatch);
      }
    );

    server.registerTool(
      "jev_get_routing_policy",
      {
        title: "Show the routing policy",
        description: `Show the active routing policy: the Claude tiers (model ids, Claude Code aliases, list prices), the capability-score band for each tier, the weights, and every floor and ceiling rule.

Use to explain why a task was routed where it was, to look up valid tier ids for min_tier / max_tier, or before tuning thresholds in a JEV_ROUTER_POLICY override file. Makes no Jev call.

Args:
- response_format ('markdown' | 'json', default 'markdown'): json returns the full policy object, which is also the override file format.`,
        inputSchema: z.object({ response_format: responseFormatSchema }).strict(),
        outputSchema: z.object({ source: z.string(), policy: policySchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ response_format }) => {
        const loaded = loadPolicyOrError(config.routingPolicyPath);
        if (typeof loaded === "string") return errorResult(loaded);
        return toolResult({ source: loaded.source, policy: loaded.policy }, response_format, () => renderPolicy(loaded));
      }
    );
  }
};
