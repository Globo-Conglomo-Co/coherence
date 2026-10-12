/**
 * What the hooks cost the session they serve, against the latency budget.
 *
 * A tool hook runs before and after every tool call, so its time is paid
 * over and over, and a call cycle that feels sluggish is how Coherence gets
 * switched off. Each hook call's time is kept, from its process's start, so
 * loading the code counts as the user waits for it, under
 * .coherence/hook-times/<session>.jsonl, transient like the feed cursors. A tool
 * hook over the budget says so in its own answer; regulate names the
 * session's calls over it, and orient the last week's.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnforcementConfig } from "../enforcement/config.ts";
import { TOOL_HOOKS } from "./hook-events.ts";

/** Not .coherence/hooks, which holds the project's own hook voice and is committed; these are regenerated. */
export const HOOK_TIMES_DIR = join(".coherence", "hook-times");
/** The latency budget when the config declares none: the most seconds a tool hook may take. */
export const DEFAULT_LATENCY_BUDGET = 3;

/** How far back orient reads. */
const ORIENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface HookTime {
  at: string;
  event: string;
  ms: number;
  /** The Coherence version that answered; absent on records kept before it was written, read as unknown. */
  version?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
let ownVersion: string | null | undefined;

/** This installation's Coherence version, read once from its package.json; null when it cannot be read. */
export function coherenceVersion(): string | null {
  if (ownVersion !== undefined) return ownVersion;
  try {
    const pkg = JSON.parse(readFileSync(resolve(here, "..", "..", "package.json"), "utf8")) as { version?: unknown };
    ownVersion = typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    ownVersion = null;
  }
  return ownVersion;
}

function sessionFile(root: string, session: string): string {
  return join(root, HOOK_TIMES_DIR, `${session.replace(/[^\w.-]/g, "_")}.jsonl`);
}

/** The latency budget in seconds: the config's, or the default. */
export function latencyBudget(root: string): number {
  try {
    return readEnforcementConfig(root).latencyBudget ?? DEFAULT_LATENCY_BUDGET;
  } catch {
    return DEFAULT_LATENCY_BUDGET;
  }
}

/** Keep one hook call's time; a store that cannot be written loses the line, never the hook's answer. */
export function recordHookTime(root: string, session: string, time: HookTime): void {
  try {
    mkdirSync(join(root, HOOK_TIMES_DIR), { recursive: true });
    const version = time.version ?? coherenceVersion();
    appendFileSync(sessionFile(root, session), JSON.stringify(version === null ? time : { ...time, version }) + "\n");
  } catch {
    // Timing is a reading of the hook, not part of its answer.
  }
}

export function parseHookTimes(text: string): HookTime[] {
  return text.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as Partial<HookTime>;
      return typeof value.at === "string" && typeof value.event === "string" && typeof value.ms === "number" ? [value as HookTime] : [];
    } catch {
      return [];
    }
  });
}

export function hookTimes(root: string, session: string): HookTime[] {
  try {
    return parseHookTimes(readFileSync(sessionFile(root, session), "utf8"));
  } catch {
    return [];
  }
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** The line a tool hook over the budget adds to its own answer, or "" within it. */
export function overBudgetLine(event: string, ms: number, budgetSeconds: number): string {
  if (!TOOL_HOOKS.has(event) || ms <= budgetSeconds * 1000) return "";
  return `Hook latency: this ${event} took ${seconds(ms)}, over the ${budgetSeconds} s latency budget for a tool hook; it runs around every tool call, and a call cycle that slow gets Coherence switched off.`;
}

function summary(over: readonly HookTime[], all: readonly HookTime[], budgetSeconds: number, span: string): string {
  const slowest = over.reduce((a, b) => (b.ms > a.ms ? b : a));
  const tool = all.filter((t) => TOOL_HOOKS.has(t.event));
  const total = tool.reduce((sum, t) => sum + t.ms, 0);
  return `Hook latency: ${over.length} tool hook call${over.length === 1 ? "" : "s"} ${span} took longer than the ${budgetSeconds} s latency budget (slowest ${slowest.event} ${seconds(slowest.ms)}); the ${tool.length} tool hook calls took ${seconds(total)} in all, ${seconds(total / Math.max(tool.length, 1))} each.`;
}

/** Regulate's line: this session's tool hook calls over the budget, with what the tool hooks cost in all; "" when none was over. */
export function hookLatencyStopText(root: string, session: string | undefined): string {
  if (session === undefined) return "";
  const budget = latencyBudget(root);
  const all = hookTimes(root, session);
  const over = all.filter((t) => TOOL_HOOKS.has(t.event) && t.ms > budget * 1000);
  return over.length === 0 ? "" : summary(over, all, budget, "this session");
}

/** Orient's line: the last week's tool hook calls over the budget, across sessions; "" when none was. */
export function hookLatencyOrientText(root: string, now: () => number = Date.now): string {
  const dir = join(root, HOOK_TIMES_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return "";
  }
  const since = now() - ORIENT_WINDOW_MS;
  const all: HookTime[] = [];
  for (const name of names) {
    try {
      // A session file untouched for a week holds nothing the window reads.
      if (statSync(join(dir, name)).mtimeMs < since) continue;
      all.push(...parseHookTimes(readFileSync(join(dir, name), "utf8")).filter((t) => Date.parse(t.at) >= since));
    } catch {
      continue;
    }
  }
  const budget = latencyBudget(root);
  const over = all.filter((t) => TOOL_HOOKS.has(t.event) && t.ms > budget * 1000);
  return over.length === 0 ? "" : summary(over, all, budget, "in the last 7 days") + "\n\n";
}
