// Coherence in Claude Code through one warm process per session (spike).
//
// The settings hooks spawn `coherence hook <Event>` for every event, paying
// for Node and Coherence's code each time. This mod starts `coherence
// hook-serve --socket` once, at the session's start, and answers the seven
// classic events Coherence hooks through it: the same runHook, the same
// output, the same records. Whatever the warm process cannot answer (not up
// yet, gone, its code changed on disk) runs through `coherence hook <Event>`
// as before, and a process that went down is said to the user.
//
// What reaches the agent is what Coherence's hooks give it (context, a
// block, a refusal); what only the user reads goes to the user's channels:
// the stop's digest under the answer, a verdict on an edit's row, the hook
// time and practices owed in the status line. Coherence refuses and informs;
// it never grants a tool call.
//
// The band above the prompt holds two buttons for the person: Scope, the live
// reading in the browser, and Journal, the session's journal told in a pane
// (journal-pane.tsx), each record with a small tree of the files it touched.

import type { EngineInterface as Engine, Register } from 'claude-code'
import type { CoherenceVerdict } from '../types'
import { WRITER_TOOLS } from './writers.ts'
import { EVENTS, request, settingsRunCoherence, translate, verdictLine, type Classic, type CoherenceEvent, type HookAnswer } from './answer.ts'
import { JOURNAL_COMMAND, JOURNAL_PANE, JOURNAL_TOOL, journalPane } from './journal-pane.tsx'
import { place } from './place.ts'

/** The tools whose PreToolUse Coherence's settings hook is installed for: the tools that write, as host-tools.ts declares them. */
const PRACTICE_TOOLS = new Set(WRITER_TOOLS)
/** How many times a session restarts a warm process that went down before it stays on the CLI. */
const RESTARTS = 2
/** How long a stop's digest waits for the turn's end to show it, before it is logged instead. */
const DIGEST_WAIT_MS = 3000
/** The keys a tool call's envelope carries that are not the tool's own input. */
const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])
const NODE = ['node', '--disable-warning=ExperimentalWarning']

type Warm = { state: 'off' } | { state: 'starting' } | { state: 'warm'; socket: string } | { state: 'down'; reason: string }
type Via = 'warm' | 'cli'

/** The session's own: a reload of the module starts it over, and the warm process with it (its loop ends with the module). */
const held = {
  warm: { state: 'off' } as Warm,
  restarts: 0,
  cli: undefined as string | undefined,
  root: '',
  seq: 0,
  digest: undefined as string | undefined,
  /** The last subagent stop's digest said, so the next identical one is not said again. */
  lastSubagentDigest: undefined as string | undefined,
  last: {} as { session_id?: string; cwd?: string },
  aside: new Set<CoherenceEvent>(),
  times: [] as { event: string; via: Via; ms: number }[],
  timesFile: undefined as string | undefined,
  setup: undefined as Promise<void> | undefined,
  ending: false,
  /** Which warm process is the current one: a process that ended after another replaced it says nothing. */
  generation: 0,
}

/** Set up once, by whichever comes first: the classic SessionStart fires before session.start does. */
function ready($: Engine): Promise<void> {
  held.setup ??= setUp($)
  return held.setup
}

/**
 * Where Coherence's command line is: COHERENCE_HOME's checkout; else the
 * project's own installed Coherence, whatever its version, since this mod is
 * one per machine and every project keeps its own; else, in Coherence's own
 * repository, its source; else the checkout this mod was loaded from with
 * --plugin-dir.
 */
async function locate($: Engine): Promise<string | undefined> {
  const home = await $.env.get('COHERENCE_HOME')
  const ownRepository = (await $.fs.stat(`${held.root}/mods/coherence/.claude-plugin/plugin.json`).catch(() => undefined))?.kind === 'file'
  const candidates = [
    ...(home === undefined || home === '' ? [] : [`${home}/src/cli.ts`]),
    `${held.root}/node_modules/@posthog/coherence/dist/cli.js`,
    ...(ownRepository ? [`${held.root}/src/cli.ts`] : []),
    `${$.plugin.root}/../../src/cli.ts`,
  ]
  for (const path of candidates) {
    const found = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
    if (found?.kind === 'file' && found.realPath !== undefined) return found.realPath
  }
  return undefined
}

function say($: Engine, text: string): void {
  $.ui.toast(text)
  $.ui.log(text)
}

/**
 * In Coherence's own repository each tree runs its own mod, linked from the
 * project's skills folder; an installed copy takes the name first and runs
 * instead, which nothing else would show. Said once, where the person reads it.
 */
async function sayWhenNotOwn($: Engine): Promise<void> {
  const own = await $.fs.stat(`${held.root}/mods/coherence/.claude-plugin/plugin.json`, { resolve: true }).catch(() => undefined)
  if (own?.kind !== 'file' || own.realPath === undefined) return
  const running = await $.fs.stat(`${$.plugin.root}/.claude-plugin/plugin.json`, { resolve: true }).catch(() => undefined)
  if (running?.realPath === own.realPath) return
  const installed = running?.realPath?.includes('/.claude/plugins/') === true
  say($, installed
    ? `Coherence: an installed copy of the mod (${$.plugin.root}) runs here in place of this tree's own mods/coherence, so edits to it are not loaded; \`node src/cli.ts hooks uninstall --host claude\` removes the copy installed for this repository, and \`claude plugin uninstall coherence@coherence --scope user\` one installed for you.`
    : `Coherence: the mod running here is ${running?.realPath?.replace(/\/\.claude-plugin\/plugin\.json$/, '') ?? $.plugin.root}, not this tree's own mods/coherence; edits there reload it, edits here do not.`)
}

async function setUp($: Engine): Promise<void> {
  held.root = await $.session.root()
  held.timesFile = await $.env.get('COHERENCE_MOD_TIMES')
  held.cli = await locate($)
  // The Journal pane reads where Coherence is from here: data only, never the engine interface.
  place.root = held.root
  place.cli = held.cli
  const hooks = (await $.settings.read()).hooks
  for (const event of EVENTS) if (settingsRunCoherence(hooks, event)) held.aside.add(event)
  if (held.aside.size > 0) $.ui.log(`Coherence: the settings hooks already run Coherence for ${[...held.aside].join(', ')}; the mod leaves those to them, since answering too would run each check twice. \`coherence hooks uninstall --host claude\` hands them to the warm process.`)
  await sayWhenNotOwn($)
  if (held.cli === undefined) say($, 'Coherence: the mod found no Coherence command line (COHERENCE_HOME, node_modules/@posthog/coherence, or the checkout it ships in); its hooks do nothing this session.')
  start($)
}

/** Start the warm process; its loop is the child's life, and its end says the process went down. */
function start($: Engine): void {
  const cli = held.cli
  if (cli === undefined) return
  held.warm = { state: 'starting' }
  const generation = ++held.generation
  void (async () => {
    let buffer = ''
    let why = 'it exited'
    try {
      const child = $.process.spawn({ argv: [...NODE, cli, 'hook-serve', '--socket'], cwd: held.root, env: { CLAUDE_PROJECT_DIR: held.root } })
      for await (const { stream, text } of child) {
        if (stream === 'stderr') {
          $.ui.log(`coherence hook-serve: ${text}`, { to: 'debug' })
          continue
        }
        buffer += text
        for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
          const line = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          try {
            const said = JSON.parse(line) as { ready?: { socket?: unknown } }
            if (typeof said.ready?.socket === 'string' && generation === held.generation) held.warm = { state: 'warm', socket: said.ready.socket }
          } catch {
            // Not a line of the protocol: the process's own output, kept for the debug log.
            $.ui.log(`coherence hook-serve: ${line}`, { to: 'debug' })
          }
        }
      }
      // The host ends the child with SIGTERM as the session or the module ends, and hook-serve exits 0 only when it was asked to
      // end (a signal, its stdin or parent gone, its code stale, which the stale answer already reported): no failure to report.
      const ended = await child.result.catch(() => undefined)
      if (ended?.signal === 'SIGTERM' || ended?.code === 0) held.ending = true
      else if (ended !== undefined) why = ended.signal === null ? `it exited with code ${ended.code}` : `it was ended by ${ended.signal}`
    } catch (error) {
      why = `it could not start (${error instanceof Error ? error.message : String(error)})`
    }
    if (generation !== held.generation) return
    if (held.ending) {
      held.ending = false
      held.warm = { state: 'off' }
      return
    }
    down($, why)
  })()
}

/** The warm process is gone: say so, and start another while the session has restarts left. */
function down($: Engine, reason: string): void {
  if (held.warm.state === 'down') return
  const again = held.restarts < RESTARTS
  held.warm = { state: 'down', reason }
  say($, `Coherence: the warm hook process went down (${reason}); each event runs \`coherence hook\` as a settings hook would${again ? ' while a new one starts' : ' for the rest of this session'}.`)
  if (again) {
    held.restarts += 1
    start($)
  }
}

/** One event through the warm process, or through the command line when it cannot answer. */
async function forward($: Engine, event: CoherenceEvent, input: Record<string, unknown>): Promise<HookAnswer & { via: Via }> {
  await ready($)
  const began = await $.clock.now()
  let answer: (HookAnswer & { via: Via }) | undefined
  const warm = held.warm
  if (warm.state === 'warm') {
    try {
      const reply = await $.http.fetch('http://coherence/hook', { method: 'POST', socketPath: warm.socket, headers: { 'content-type': 'application/json' }, body: request(++held.seq, event, input) })
      const said = JSON.parse(reply.text) as Partial<HookAnswer> & { stale?: string; error?: string }
      if (typeof said.stdout === 'string' && typeof said.stderr === 'string' && typeof said.exit === 'number') answer = { stdout: said.stdout, stderr: said.stderr, exit: said.exit, ...(said.verdict === undefined ? {} : { verdict: said.verdict }), via: 'warm' }
      else if (typeof said.stale === 'string') down($, 'its code changed on disk')
      else $.ui.log(`Coherence: the warm process could not answer ${event} (${said.error ?? reply.text.slice(0, 200)}); it ran through \`coherence hook\``)
    } catch (error) {
      down($, `unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (answer === undefined) {
    const cli = held.cli
    if (cli === undefined) return { stdout: '', stderr: '', exit: 0, via: 'cli' }
    const ran = await $.process.run([...NODE, cli, 'hook', event], { cwd: held.root, env: { CLAUDE_PROJECT_DIR: held.root }, stdin: JSON.stringify(input), timeoutMs: 60_000 })
    answer = { stdout: ran.stdout, stderr: ran.stderr, exit: ran.exitCode, via: 'cli' }
  }
  held.times.push({ event, via: answer.via, ms: Math.round((await $.clock.now()) - began) })
  const file = held.timesFile
  if (file !== undefined && file !== '') await $.fs.write(file, held.times.map((t) => JSON.stringify(t)).join('\n') + '\n').catch(() => undefined)
  return answer
}

/**
 * A message as one line: a transcript line and the text under an answer are
 * each drawn on one line, a newline inside them as a stray glyph, and a row
 * per line would bury the transcript, so its lines are joined: a heading's
 * colon runs into what follows, and other lines are set apart with " · ".
 */
function oneLine(text: string): string {
  // A heading's colon leads straight into what it heads; separate items are set apart.
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .reduce((joined, line) => (joined === '' ? line : `${joined}${joined.endsWith(':') ? ' ' : ' · '}${line}`), '')
}

/** What only the user reads: a stop's digest waits for the turn's end, anything else is transcript lines now. */
function tell($: Engine, event: CoherenceEvent, user: string | undefined, debug: string | undefined): void {
  if (debug !== undefined && debug !== '') $.ui.log(`Coherence ${event}: ${debug}`, { to: 'debug' })
  if (user === undefined) return
  const line = oneLine(user)
  if (event !== 'Stop') {
    // Every subagent's stop says its digest; one the user has just read is not said again.
    if (event === 'SubagentStop' && held.lastSubagentDigest === line) return
    if (event === 'SubagentStop') held.lastSubagentDigest = line
    $.ui.log(line)
    return
  }
  held.digest = line
  $.clock.after(DIGEST_WAIT_MS, () => {
    if (held.digest === line) {
      held.digest = undefined
      $.ui.log(line)
    }
  })
}

/** The verdict an edit's check left, for the row's one line. */
async function keepVerdict($: Engine, toolUseId: unknown, answer: HookAnswer): Promise<void> {
  const line = verdictLine(answer.verdict)
  if (line === undefined || typeof toolUseId !== 'string' || toolUseId === '') return
  const verdict: CoherenceVerdict = line
  await $.state.set({ plugin: 'coherence', key: 'verdict', id: toolUseId }, verdict)
}

/** The status line: Coherence's own (version, hook time against the budget, practices owed), then how its hooks are answered. */
async function refreshStatus($: Engine): Promise<void> {
  const recent = held.times.slice(-20)
  // The median, not the mean: a few heavy events (a leaf's first entry, a stop) would pull a mean far from the usual event.
  const mean = (via: Via): string => {
    const these = recent.filter((t) => t.via === via).map((t) => t.ms).sort((a, b) => a - b)
    return these.length === 0 ? '' : `, median ${Math.round(these[Math.floor(these.length / 2)]!)} ms`
  }
  const warm = held.warm
  const route = warm.state === 'warm' ? `warm${mean('warm')}` : warm.state === 'down' ? `cli per event${mean('cli')} (warm process down)` : warm.state === 'starting' ? 'warm process starting' : `cli per event${mean('cli')}`
  let line = ''
  if (warm.state === 'warm' && held.last.session_id !== undefined) {
    try {
      const reply = await $.http.fetch('http://coherence/status', { method: 'POST', socketPath: warm.socket, body: JSON.stringify({ id: ++held.seq, op: 'status', input: held.last }) })
      const said = JSON.parse(reply.text) as { status?: unknown }
      // The host already leads the status line with the mod's name, so the text does not say coherence again.
      if (typeof said.status === 'string' && said.status !== '') line = said.status.replace(/^coherence /, '')
    } catch {
      // The next event finds a process that is gone and says so; the status line keeps its last word until then.
    }
  }
  $.ui.status(line === '' ? route : `${line} · ${route}`)
}

/** What the agent reads when this mod's own hook failed: the event went on without Coherence's answer. */
function missed<R extends { additionalContext?: string[] }>(below: R, event: CoherenceEvent, error: { kind: string; message?: string }): R {
  const why = error.kind === 'timeout' ? 'it ran out of time' : `it failed (${error.message ?? error.kind})`
  return { ...below, additionalContext: [...(below.additionalContext ?? []), `Coherence's ${event} hook did not answer at this event: ${why}; its checks and records for this event did not run.`] }
}

function merge<R extends { additionalContext?: string[]; block?: string }>(below: R, mine: Classic): R {
  const out: R = { ...below }
  if (mine.additionalContext !== undefined) out.additionalContext = [...(below.additionalContext ?? []), ...mine.additionalContext]
  if (mine.block !== undefined) out.block = below.block === undefined ? mine.block : `${below.block}\n${mine.block}`
  return out
}

/** The classic events but PreToolUse: Coherence's answer and the settings hooks beneath, run side by side and merged. */
async function classic<R extends { additionalContext?: string[]; block?: string }>($: Engine, event: CoherenceEvent, e: Record<string, unknown>, beneath: Promise<R>): Promise<R> {
  held.last = { ...(typeof e.session_id === 'string' ? { session_id: e.session_id } : {}), ...(typeof e.cwd === 'string' ? { cwd: e.cwd } : {}) }
  const [answer, below] = await Promise.all([forward($, event, e), beneath])
  if (held.cli === undefined && event === 'SessionStart') {
    return merge(below, { additionalContext: ['Coherence is configured for this project through its Claude Code mod, but the mod found no Coherence command line, so its hooks do nothing this session: no vocabulary, specs, journal or checks. Tell the user; installing @posthog/coherence (or setting COHERENCE_HOME) is theirs to decide.'] })
  }
  const { classic: mine, user, debug } = translate(event, answer)
  tell($, event, user, debug)
  if (event === 'PostToolUse') await keepVerdict($, e.tool_use_id, answer)
  return merge(below, mine)
}

/** PreToolUse arrives as the tool call's envelope, not the settings hook's stdin: the stdin is rebuilt from it and the session. */
async function preToolUse($: Engine, e: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED.has(key)))
  const agent = e.agentId
  const agentType = typeof agent === 'string' ? (await $.agent.list()).find((a) => a.id === agent)?.type : undefined
  return {
    session_id: await $.session.id(),
    cwd: await $.session.cwd(),
    hook_event_name: 'PreToolUse',
    tool_name: e.tool,
    tool_input: input,
    tool_use_id: e.tool_use_id,
    ...(typeof agent === 'string' ? { agent_id: agent, ...(agentType === undefined ? {} : { agent_type: agentType }) } : {}),
  }
}

/** /scope: the live Scope page, opened in the browser; the address carries the project's token, so it reaches neither the transcript nor Claude. */
async function openScope($: Engine): Promise<void> {
  await ready($)
  let url: string | undefined
  let why = 'no Coherence command line'
  const warm = held.warm
  if (warm.state === 'warm') {
    try {
      const reply = await $.http.fetch('http://coherence/scope', { method: 'POST', socketPath: warm.socket, body: JSON.stringify({ id: ++held.seq, op: 'scope' }) })
      const said = JSON.parse(reply.text) as { url?: unknown; error?: unknown }
      if (typeof said.url === 'string') url = said.url
      else why = String(said.error ?? reply.text.slice(0, 200))
    } catch (error) {
      why = error instanceof Error ? error.message : String(error)
    }
  } else if (held.cli !== undefined) {
    const ran = await $.process.run([...NODE, held.cli, 'scope', '--no-open'], { cwd: held.root, timeoutMs: 120_000 })
    url = /^Scope: (http\S+)$/m.exec(ran.stdout)?.[1]
    if (url === undefined) why = ran.stderr.trim() || `exit ${ran.exitCode}`
  }
  if (url === undefined) {
    $.ui.toast(`Coherence: Scope did not open (${why})`)
    return
  }
  await $.process.run(['open', url])
  $.ui.toast('Coherence: Scope opened in your browser')
}

export const register: Register = on => {
  journalPane(on)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await ready($)
    await $.command.register({ name: 'scope', description: "Open Coherence's live Scope reading in the browser", immediate: true })
    await $.command.register(JOURNAL_COMMAND)
    await $.tool.register(JOURNAL_TOOL)
    $.clock.every(3000, () => void refreshStatus($))
    return started
  })

  // A hook of these that fails leaves the event to the settings hooks beneath, and says so where the agent reads it: never a silent skip.
  on('classic.SessionStart', ($, e, next) => (held.aside.has('SessionStart') ? next(e) : classic($, 'SessionStart', e, next(e)))).catch(async ($, e, next) => missed(await next(e), 'SessionStart', next.error))
  on('classic.SubagentStart', ($, e, next) => (held.aside.has('SubagentStart') ? next(e) : classic($, 'SubagentStart', e, next(e)))).catch(async ($, e, next) => missed(await next(e), 'SubagentStart', next.error))
  on('classic.UserPromptSubmit', ($, e, next) => (held.aside.has('UserPromptSubmit') ? next(e) : classic($, 'UserPromptSubmit', e, next(e)))).catch(async ($, e, next) => missed(await next(e), 'UserPromptSubmit', next.error))
  on('classic.PostToolUse', ($, e, next) => (held.aside.has('PostToolUse') ? next(e) : classic($, 'PostToolUse', e, next(e)))).catch(async ($, e, next) => missed(await next(e), 'PostToolUse', next.error))
  on('classic.Stop', ($, e, next) => (held.aside.has('Stop') ? next(e) : classic($, 'Stop', e, next(e)))).catch(async ($, e, next) => missed(await next(e), 'Stop', next.error))
  on('classic.SubagentStop', ($, e, next) => (held.aside.has('SubagentStop') ? next(e) : classic($, 'SubagentStop', e, next(e)))).catch(async ($, e, next) => missed(await next(e), 'SubagentStop', next.error))

  on('classic.PreToolUse', async ($, e, next) => {
    if (held.aside.has('PreToolUse') || !PRACTICE_TOOLS.has(String(e.tool))) return next(e)
    const [answer, below] = await Promise.all([forward($, 'PreToolUse', await preToolUse($, e)), next(e)])
    const { classic: mine, user, debug } = translate('PreToolUse', answer)
    tell($, 'PreToolUse', user, debug)
    // A refusal stands over whatever beneath decided; Coherence never answers allow or ask.
    if (mine.deny !== undefined) return { deny: mine.deny, ...(below.additionalContext === undefined ? {} : { additionalContext: below.additionalContext }) }
    if (mine.additionalContext === undefined) return below
    return { ...below, additionalContext: [...(below.additionalContext ?? []), ...mine.additionalContext] }
  }).catch(async ($, e, next) => missed(await next(e), 'PreToolUse', next.error))

  // The stop's digest, which a settings hook shows the user as its systemMessage, shows beneath the answer instead.
  on('session.end', ($, e, next) => {
    held.ending = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    const text = held.digest
    if (e.agentId !== undefined || text === undefined) return answered
    held.digest = undefined
    return { ...answered, text }
  })

  // An edit's verdict on the tool call's own row, where the user alone reads it.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const verdict = await $.state.get({ plugin: 'coherence', key: 'verdict', id: e.props.tool_use_id })
    if (verdict.value === undefined) return next(e)
    const row = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {row}
        <Text color={verdict.value.isFailed ? 'error' : 'subtle'}>  ⎿ coherence {verdict.value.text}</Text>
      </Box>
    )
  })

  // The band above the prompt, for the person: Scope opens as /scope does, Journal as /journal does; it yields to a survey.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    // A row of its own, set off from the transcript above: the tool's name dim, its button drawn as one right beside it, whatever the width.
    return (
      <Box marginTop={1} gap={2}>
        <Text dimColor>coherence</Text>
        <Button key="scope" label="Scope ↗" variant="primary" onPress={() => void openScope($)} />
        <Button key="journal" label="Journal" onPress={() => void $.ui.open({ id: JOURNAL_PANE, title: 'Journal' })} />
      </Box>
    )
  })

  on('command.run', { command: 'scope' }, async $ => {
    await openScope($)
    return {}
  })
}
