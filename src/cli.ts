#!/usr/bin/env node
/**
 * jev-route: the routing module as a command-line tool, for scripts and Claude Code hooks.
 *
 *   jev-route "Fix the flaky test in auth.spec.ts"      # Markdown decision
 *   echo "..." | jev-route --json --source user_turn    # JSON decision
 *   jev-route --hook                                     # UserPromptSubmit hook mode
 *
 * In --hook mode the hook's JSON payload is read from stdin and a one-line routing note is
 * printed to stdout, which Claude Code adds to the turn's context. Failures never block the
 * prompt: the hook exits 0 and prints nothing.
 */

import { loadConfig } from "./config.js";
import { JevClient } from "./jev/client.js";
import { renderDecision } from "./modules/routing/format.js";
import { loadPolicy } from "./modules/routing/policy.js";
import { routeTask } from "./modules/routing/router.js";
import type { TaskSource } from "./modules/routing/questions.js";

interface Args {
  json: boolean;
  hook: boolean;
  source: TaskSource;
  context?: string;
  task?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, hook: false, source: "subagent_task" };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") args.json = true;
    else if (arg === "--hook") args.hook = true;
    else if (arg === "--source") args.source = argv[++i] === "user_turn" ? "user_turn" : "subagent_task";
    else if (arg === "--context") args.context = argv[++i];
    else rest.push(arg);
  }
  if (rest.length) args.task = rest.join(" ");
  return args;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function runHook(): Promise<void> {
  try {
    const payload = JSON.parse(await readStdin()) as { prompt?: unknown };
    const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
    // Slash commands and very short acknowledgements are not worth a routing call.
    if (!prompt || prompt.startsWith("/") || prompt.length < 4) return;
    const config = loadConfig();
    const decision = await routeTask(new JevClient(config), loadPolicy(config.routingPolicyPath).policy, {
      task: prompt,
      source: "user_turn"
    }, { logPath: config.routingLogPath });
    if (decision.status !== "routed") return;
    process.stdout.write(
      `[Jev router] This request scores as ${decision.tier}-tier work (effort ${decision.effort}; ` +
        `type ${decision.task_type?.choice}, score ${decision.scores?.effective}). ` +
        `If you delegate any of it to a subagent, use model "${decision.claude_code_alias}" unless a sub-task clearly needs more or less.\n`
    );
  } catch (error) {
    console.error(`[jev-route] hook skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.hook) return runHook();

  const task = (args.task ?? (await readStdin())).trim();
  if (!task) {
    console.error('Usage: jev-route [--json] [--source user_turn|subagent_task] [--context "..."] "task text"  (or pipe the task on stdin)');
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const decision = await routeTask(
    new JevClient(config),
    loadPolicy(config.routingPolicyPath).policy,
    { task, context: args.context, source: args.source },
    { logPath: config.routingLogPath }
  );
  process.stdout.write(`${args.json ? JSON.stringify(decision, null, 2) : renderDecision(decision)}\n`);
  if (decision.status === "degraded") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`[jev-route] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
