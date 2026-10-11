/**
 * The routing question set: one Jev request per task, every question answered in parallel.
 *
 * Each question is one narrow judgment (TypeSafe's "atomic questions" guidance). Code in
 * decide.ts combines the answers; nothing here encodes policy. Question ids are for code
 * only and are never sent to the model, so every instruction is self-contained.
 */

import { choice, noul, score, type EntryType } from "@typesafe-ai/sdk";

export type TaskSource = "user_turn" | "subagent_task";

export interface RoutingInput {
  task: string;
  context?: string;
  source: TaskSource;
}

/** Jev accuracy falls as state grows; keep the task to roughly 5k tokens (head and tail kept). */
export const MAX_TASK_CHARS = 20_000;
export const MAX_CONTEXT_CHARS = 4_000;

const SOURCE_DESCRIPTIONS: Record<TaskSource, string> = {
  user_turn: "A message the user typed into an interactive Claude Code session.",
  subagent_task:
    "Instructions an orchestrating agent wrote for a delegated subagent, which starts with no other conversation history."
};

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return {
    text: `${text.slice(0, head)}\n[... ${text.length - limit} characters omitted ...]\n${text.slice(-tail)}`,
    truncated: true
  };
}

export function buildRoutingState(input: RoutingInput): { state: EntryType; truncated: boolean } {
  const task = clip(input.task.trim(), MAX_TASK_CHARS);
  const context = input.context?.trim() ? clip(input.context.trim(), MAX_CONTEXT_CHARS) : undefined;
  const state: Record<string, string> = {
    environment:
      "Claude Code: an AI coding agent working in a software repository. It can read and edit files, run shell commands, and search the web.",
    task_source: SOURCE_DESCRIPTIONS[input.source],
    task: task.text
  };
  if (context) state.context = context.text;
  return { state, truncated: task.truncated || (context?.truncated ?? false) };
}

export const TASK_TYPES = {
  explain: "Explain, summarize, or answer a question about existing code, documents, or concepts, without changing anything",
  locate: "Find or look up something specific, such as a file, symbol, setting, command, or fact",
  small_edit: "Make a small, clearly specified change, such as a rename, typo fix, config value, or one-function tweak",
  feature: "Build new functionality or make a coordinated change across several files",
  debug: "Find and fix the cause of a bug, error, crash, or failing test",
  refactor: "Restructure or migrate existing code while keeping its behavior",
  review: "Review code or a change for bugs, security problems, or quality",
  design: "Plan an architecture or approach, or weigh technical trade-offs",
  research: "Gather and synthesize information from several sources",
  operations: "Run, build, deploy, or administer systems, environments, or infrastructure",
  conversation: "A greeting, thanks, acknowledgement, or small talk with no work requested",
  other: "None of the above"
} as const;

/** Score questions whose levels feed the capability score or risk rules. Order matters: index = level. */
export const SCORE_RUBRICS = {
  reasoning_depth: {
    instructions: "How much multi-step reasoning does completing {task} correctly require?",
    levels: [
      "None: the answer or action is immediate, like a greeting, a direct lookup, or a mechanical edit",
      "Light: a few straightforward steps with an obvious approach",
      "Moderate: several dependent steps, tracing logic across a few places, or choosing between reasonable approaches",
      "Heavy: a non-obvious root cause, subtle logic (concurrency, algorithms, math, type systems), or many interacting constraints",
      "Extreme: a novel, open-ended problem that needs sustained expert reasoning, original design, or proof-level rigor"
    ]
  },
  scope: {
    instructions: "How much code or material must be read or changed to complete {task}?",
    levels: [
      "Nothing beyond the task text itself",
      "One file or one small, clearly located spot",
      "A few related files or one module",
      "Many files across several modules or components",
      "An entire large codebase, several repositories, or a long multi-session effort"
    ]
  },
  ambiguity: {
    instructions: "How clearly does {task} specify what a finished result looks like?",
    levels: [
      "Exact: the precise change, answer, or output is stated",
      "Mostly clear: only minor details must be inferred",
      "Partly open: the goal is clear but the approach or acceptance criteria must be worked out",
      "Open-ended: requirements are vague and must be discovered, investigated, or clarified"
    ]
  },
  domain_expertise: {
    instructions: "How specialized is the knowledge needed to complete {task} correctly?",
    levels: [
      "General: everyday knowledge or routine programming",
      "Common tooling: familiarity with a popular language, framework, or tool",
      "Specialized: expertise such as security, performance tuning, distributed systems, database internals, compilers, or numerical methods",
      "Rare depth: niche expertise where even experienced engineers often make subtle mistakes"
    ]
  },
  error_cost: {
    instructions: "If {task} were done subtly wrong, how costly would the mistake be?",
    levels: [
      "Harmless: a mistake would be obvious and cost nothing",
      "Minor: easy to notice and undo, such as a local edit under version control",
      "Moderate: a subtle bug or significant wasted time before anyone notices",
      "Severe: data loss, a security hole, a production outage, financial loss, or harm that cannot be undone"
    ]
  }
} as const;

/** Yes/no conditions used as hard gates (any one can raise or cap the tier). */
export const FLAG_QUESTIONS = {
  trivial:
    "Can {task} be completed correctly with one short reply or one obvious edit, without any investigation?",
  security_sensitive:
    "Does {task} involve authentication, authorization, secrets or credentials, encryption, personal data, or a security vulnerability?",
  destructive:
    "Does {task} ask to delete data or files, rewrite version-control history, force-push, drop or migrate a database, or make another change that is hard to undo?",
  external_impact:
    "Does {task} ask to deploy, change production systems or shared infrastructure, publish, send messages, spend money, or otherwise act outside the local working copy?",
  explicit_depth_request:
    "Does {task} explicitly ask for extra care or depth, with words such as 'think hard', 'be thorough', 'double-check', or 'use your best model'?",
  needs_prior_context:
    "Does {task} only make sense with earlier conversation, such as 'do it', 'continue', 'try again', or 'use that approach', without saying what the work is?"
} as const;

export type ScoreName = keyof typeof SCORE_RUBRICS;
export type FlagName = keyof typeof FLAG_QUESTIONS;
export type TaskType = keyof typeof TASK_TYPES;

export const SCORE_NAMES = Object.keys(SCORE_RUBRICS) as ScoreName[];
export const FLAG_NAMES = Object.keys(FLAG_QUESTIONS) as FlagName[];

export function scoreMax(name: ScoreName): number {
  return SCORE_RUBRICS[name].levels.length - 1;
}

/** Signal names a policy condition may reference. */
export function isKnownSignal(name: string): boolean {
  if (name.startsWith("task_type:")) return name.slice("task_type:".length) in TASK_TYPES;
  return name in SCORE_RUBRICS || name in FLAG_QUESTIONS;
}

/** Build the question map. Wording changes slightly when the caller supplies background context. */
export function buildRoutingQuestions(hasContext: boolean) {
  const subject = hasContext ? "`task` (using `context` as background)" : "`task`";
  const fill = (template: string) => template.replace("{task}", subject);

  return {
    task_type: choice(`What kind of work does ${subject} ask for?`, TASK_TYPES),
    reasoning_depth: score(fill(SCORE_RUBRICS.reasoning_depth.instructions), SCORE_RUBRICS.reasoning_depth.levels),
    scope: score(fill(SCORE_RUBRICS.scope.instructions), SCORE_RUBRICS.scope.levels),
    ambiguity: score(fill(SCORE_RUBRICS.ambiguity.instructions), SCORE_RUBRICS.ambiguity.levels),
    domain_expertise: score(fill(SCORE_RUBRICS.domain_expertise.instructions), SCORE_RUBRICS.domain_expertise.levels),
    error_cost: score(fill(SCORE_RUBRICS.error_cost.instructions), SCORE_RUBRICS.error_cost.levels),
    trivial: noul(fill(FLAG_QUESTIONS.trivial)),
    security_sensitive: noul(fill(FLAG_QUESTIONS.security_sensitive)),
    destructive: noul(fill(FLAG_QUESTIONS.destructive)),
    external_impact: noul(fill(FLAG_QUESTIONS.external_impact)),
    explicit_depth_request: noul(fill(FLAG_QUESTIONS.explicit_depth_request)),
    needs_prior_context: noul(
      hasContext
        ? "Does `task` only make sense with earlier conversation, such as 'do it', 'continue', or 'try again', and does `context` also fail to say what the work is?"
        : fill(FLAG_QUESTIONS.needs_prior_context)
    )
  };
}

export type RoutingQuestions = ReturnType<typeof buildRoutingQuestions>;
