/**
 * The hook events Coherence answers, declared once. Kept apart from the hook
 * itself, with no import at all, so telemetry's session summary, the latency
 * budget and the benchmarks read these same names rather than a copy, without
 * loading every module the hook loads.
 */

export const HOOK_EVENTS = [
  "SessionStart",
  "SubagentStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(name: string): name is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(name);
}

/** The events that run around every tool call, which the latency budget holds. */
export const TOOL_HOOKS: ReadonlySet<string> = new Set<HookEvent>(["PreToolUse", "PostToolUse"]);
