import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SOCKET = '/tmp/coh-test/hook.sock'
const CONTEXT = 'Practice src/x/witness a refutation fires here.'

/** The engine beneath the mod: a session in /p, no settings hooks, a CLI that answers with `cliStdout`, and a warm process the test controls. */
function engine(on: On, warm: { fetch: (body: string) => string }, cliStdout: string): { said: string[]; ran: string[][] } {
  const said: string[] = []
  const ran: string[][] = []
  mock.env(on, { COHERENCE_HOME: '/coh' })
  on('session.root', () => ({ value: '/p' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/p' }))
  on('fs.stat', ($, e) => (e.path === '/coh/src/cli.ts' ? { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false, realPath: '/coh/src/cli.ts' } } : Promise.reject(new Error('ENOENT'))))
  on('fs.write', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // Time stands still: the status line's timer and the digest's fallback never fire unless a test moves the clock.
  mock.clock(on)
  on('ui.toast', ($, e) => {
    said.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    if (e.to !== 'debug') said.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  // The warm process: ready at once, then alive for the rest of the test.
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ ready: { socket: SOCKET, pid: 1, version: '1.7.0' } })}\n` }
    await new Promise(() => {})
  })
  on('http.fetch', ($, e) => ({ value: { status: 200, ok: true, headers: {}, text: warm.fetch(e.init?.body ?? '') } }))
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: cliStdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('classic.SessionStart', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.Stop', () => ({}))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { said, ran }
}

/** The session's start, which sets the mod up and starts the warm process; it runs through the command line, the process not yet up. */
async function started($: Engine): Promise<void> {
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
}

const post = { tool_name: 'Edit', tool_input: { file_path: '/p/a.ts' }, tool_response: {}, tool_use_id: 't1', cwd: '/p' }

test('an edit answered by the warm process carries its context to the agent and runs no command line', async ($, on) => {
  const answer = { id: 1, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: CONTEXT } }), stderr: '', exit: 0, ms: 3 }
  const seen = engine(on, { fetch: () => JSON.stringify(answer) }, '')
  await started($)
  const before = seen.ran.length
  const result = await $.classic.PostToolUse(post)
  expect(result.additionalContext).toEqual([CONTEXT])
  expect(seen.ran.length).toBe(before)
})

test('a warm process that cannot be reached is said to the user, and the event runs through the command line with the same answer', async ($, on) => {
  const cli = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: CONTEXT } })
  const seen = engine(on, { fetch: () => { throw new Error('connect ENOENT /tmp/coh-test/hook.sock') } }, cli)
  await started($)
  const result = await $.classic.PostToolUse(post)
  expect(result.additionalContext).toEqual([CONTEXT])
  expect(seen.ran.at(-1)).toEqual(['node', '--disable-warning=ExperimentalWarning', '/coh/src/cli.ts', 'hook', 'PostToolUse'])
  expect(seen.said.some((line) => line.includes('the warm hook process went down (unreachable'))).toBe(true)
})

test("a stop's digest reaches the user under the answer, never the agent's context", async ($, on) => {
  const digest = 'Regulate (Stop):\nSpec:\n  1 problem'
  const answer = { id: 1, stdout: JSON.stringify({ systemMessage: digest }), stderr: '', exit: 0, ms: 3 }
  engine(on, { fetch: () => JSON.stringify(answer) }, '')
  await started($)
  const stopped = await $.classic.Stop({ stop_hook_active: false, cwd: '/p' })
  expect(stopped.additionalContext).toBe(undefined)
  const turn = await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'u1', reason: 'answer' })
  expect(turn.text).toBe(digest)
})

test('a refusal blocks the stop with its reason, as the settings hook exit 2 does', async ($, on) => {
  const answer = { id: 1, stdout: '', stderr: 'Regulate found what this session owes', exit: 2, ms: 3 }
  engine(on, { fetch: () => JSON.stringify(answer) }, '')
  await started($)
  const stopped = await $.classic.Stop({ stop_hook_active: false, cwd: '/p' })
  expect(stopped.block).toBe('Regulate found what this session owes')
})

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`an edit's verdict marks its tool row on the ${surface}, and a row without one is the engine's own`, async ($, on) => {
    const verdict = { checked: 0, failed: [{ invariant: 'auth/one door', bypass: 'a.ts:3 in f' }], unchecked: 0 }
    const answer = { id: 1, stdout: '', stderr: '', exit: 0, ms: 3, verdict }
    engine(on, { fetch: () => JSON.stringify(answer) }, '')
    on('ui.render', { component: 'ToolUse' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>Edit(a.ts)</Text>
    })
    await started($)
    await $.classic.PostToolUse(post)
    const props = { tool_use_id: 't1', tool: 'Edit', input: {}, isRunning: false, isErrored: false, isInterrupted: false }
    const marked = await $.ui.mount({ plugin: 'coherence', surface, component: 'ToolUse', props, requestId: 't1' })
    expect((await marked.find({ text: /✗ bypass: auth\/one door \(a\.ts:3 in f\)/ })) !== undefined).toBe(true)
    const plain = await $.ui.mount({ plugin: 'coherence', surface, component: 'ToolUse', props: { ...props, tool_use_id: 't9' }, requestId: 't9' })
    expect(await plain.find({ text: /coherence/ })).toBe(undefined)
  })
}
