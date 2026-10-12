// What a Coherence hook answer means to Claude Code's classic chain, kept free
// of `$` so the mapping reads alone: the per-event hook's stdout, stderr and
// exit code in, the classic result and what only the user reads out.

/** The events the mod answers through the warm process, as the settings hooks name them: every one `coherence hooks install --host claude` wires. */
export const EVENTS = ['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop'] as const
export type CoherenceEvent = (typeof EVENTS)[number]

/** An edit's chokepoint check as hook-serve says it (EditVerdict in src/lifecycle/hook.ts). */
export type Verdict = {
  checked: number
  failed: { invariant: string; bypass?: string }[]
  unchecked: number
  reason?: string
}

/** One event's answer, from the warm process or from `coherence hook <event>`. */
export type HookAnswer = { stdout: string; stderr: string; exit: number; verdict?: Verdict }

/** The part of a classic result Coherence ever sets: context, a block, a deny. Never an allow. */
export type Classic = { additionalContext?: string[]; block?: string; deny?: string }

/** The exit code both hosts read as a refusal, the reason on stderr. */
const REFUSE_EXIT = 2
/** The exit code of an event outside the project the hook serves: nothing told, nothing held. */
const OUTSIDE_ROOT_EXIT = 78

/**
 * The classic result an answer comes to, and the line only the user reads:
 * a `systemMessage` (a stop's digest), which a classic result cannot carry,
 * or a hook that failed as a settings hook's failure would be shown.
 */
export function translate(event: CoherenceEvent, answer: HookAnswer): { classic: Classic; user?: string; debug?: string } {
  const stderr = answer.stderr.trim()
  if (answer.exit === REFUSE_EXIT) {
    const reason = stderr === '' ? `Coherence refused at ${event} without a reason` : stderr
    return { classic: event === 'PreToolUse' ? { deny: reason } : { block: reason } }
  }
  if (answer.exit === OUTSIDE_ROOT_EXIT) return { classic: {}, debug: stderr }
  if (answer.exit !== 0) return { classic: {}, user: `Coherence ${event} hook failed (exit ${answer.exit})${stderr === '' ? '' : `: ${stderr}`}` }
  const out = answer.stdout.trim()
  if (out === '') return { classic: {} }
  let parsed: { hookSpecificOutput?: { additionalContext?: unknown }; decision?: unknown; reason?: unknown; systemMessage?: unknown }
  try {
    parsed = JSON.parse(out) as typeof parsed
  } catch {
    // A settings hook's plain stdout is context at a session start and a prompt, and a transcript line elsewhere.
    return event === 'SessionStart' || event === 'UserPromptSubmit' ? { classic: { additionalContext: [out] } } : { classic: {}, user: out }
  }
  const classic: Classic = {}
  const context = parsed.hookSpecificOutput?.additionalContext
  if (typeof context === 'string' && context !== '') classic.additionalContext = [context]
  if (parsed.decision === 'block') classic.block = typeof parsed.reason === 'string' && parsed.reason !== '' ? parsed.reason : `Coherence refused ${event} without a reason`
  const user = typeof parsed.systemMessage === 'string' && parsed.systemMessage !== '' ? parsed.systemMessage : undefined
  return user === undefined ? { classic } : { classic, user }
}

/** The row's one line for an edit's check, or undefined when the edit touched no chokepoint invariant. */
export function verdictLine(verdict: Verdict | undefined): { text: string; isFailed: boolean } | undefined {
  if (verdict === undefined) return undefined
  const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
  if (verdict.reason !== undefined) return { text: `○ ${plural(verdict.unchecked, 'invariant')} not checked: ${verdict.reason}`, isFailed: false }
  const first = verdict.failed[0]
  if (first !== undefined) {
    const more = verdict.failed.length > 1 ? ` and ${verdict.failed.length - 1} more` : ''
    return { text: `✗ bypass: ${first.invariant}${first.bypass === undefined ? '' : ` (${first.bypass})`}${more}`, isFailed: true }
  }
  const unchecked = verdict.unchecked > 0 ? `, ${verdict.unchecked} not checked` : ''
  if (verdict.checked > 0) return { text: `✓ ${plural(verdict.checked, 'invariant')}${unchecked}`, isFailed: false }
  if (verdict.unchecked > 0) return { text: `○ ${plural(verdict.unchecked, 'invariant')} not checked`, isFailed: false }
  return undefined
}

/**
 * Whether the settings in force already run Coherence's own hook for this
 * event: then the mod stands aside for it, since answering too would run
 * every check and write every record twice.
 */
export function settingsRunCoherence(hooks: unknown, event: CoherenceEvent): boolean {
  if (typeof hooks !== 'object' || hooks === null) return false
  const groups = (hooks as Record<string, unknown>)[event]
  if (!Array.isArray(groups)) return false
  const ours = new RegExp(`\\bhook\\s+${event}\\b`)
  return groups.some((group) => {
    const inner = (group as { hooks?: unknown }).hooks
    return Array.isArray(inner) && inner.some((h) => typeof (h as { command?: unknown }).command === 'string' && /coherence/i.test((h as { command: string }).command) && ours.test((h as { command: string }).command))
  })
}

/** One request line of the warm process's protocol (hook-serve.ts). */
export function request(id: number, event: CoherenceEvent, input: unknown): string {
  return JSON.stringify({ id, op: 'hook', event, input })
}
