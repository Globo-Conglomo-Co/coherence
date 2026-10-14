import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { commitsOf, entriesOf, headlineOf, sessionOf, sourceOf, verbOf, wordsOf, writesOf, type Recorded } from '../hooks/journal.ts'
import { treeOf } from '../hooks/tree.ts'

const SESSION = '8efd6465-4c20-4d13-9f34-c17de56799d9'
const RECORDS: Recorded[] = [
  { id: 'df-608d319a', kind: 'defect', at: '2026-10-12T11:09:25.729Z', session: SESSION, agent: 'main', commit: '95683be', what: 'Tests pay the CLI start once per call', files: ['src/lifecycle/install.test.ts', 'src/readings/scope/component-interfaces.test.ts'] },
  { id: 'd-de52921c', kind: 'decision', at: '2026-10-12T11:15:02.039Z', session: SESSION, agent: 'main', commit: 'c9798a1', chose: 'CI runs the unit tests in two shards', over: ['one verify job running npm test'], because: 'the unit step is bound by the runner cores', cites: ['df-608d319a'] },
  { id: 'd-3af1ab42', kind: 'decision', at: '2026-10-12T11:15:22.044Z', session: SESSION, agent: 'main', commit: 'c114081', chose: 'the prefilter pass runs in the CI bench job', human: 'keep the fixtures', cites: ['df-608d319a'] },
]
// The branch's first-parent line from the newest record's commit, newest first: the records commit, the work commit, the defect's.
const LOG = ['@c114081', '.coherence/journal/x.jsonl', '', '@c9798a1', '.github/workflows/ci.yml', 'package.json', 'src/readings/scope/both-ways.ts', '', '@95683be', 'mods/coherence/hooks/register.tsx'].join('\n')

test('a record pings what it names, what the branch committed since the record before, else what it cites', async () => {
  const told = entriesOf(RECORDS, commitsOf(LOG), [])
  expect(told.map(r => [r.id, r.from, r.pings.map(p => `${p.path}${p.kind === 'edit' ? ' ✎' : ''}`)])).toEqual([
    ['df-608d319a', ['named'], ['src/lifecycle/install.test.ts', 'src/readings/scope/component-interfaces.test.ts']],
    ['d-de52921c', ['committed'], ['.github/workflows/ci.yml ✎', 'package.json ✎', 'src/readings/scope/both-ways.ts ✎']],
    // Its range holds only Coherence's own records, which are no file of the project: it pings what it cites.
    ['d-3af1ab42', ['cited'], ['src/lifecycle/install.test.ts', 'src/readings/scope/component-interfaces.test.ts']],
  ])
  expect(sourceOf(told[1]?.from ?? [])).toBe('changed')
})

test("the hooks' write trace, when it has the session's writes, is what a record pings ahead of the commits", async () => {
  const writes = writesOf(['{"kind":"read","at":"2026-10-12T11:10:00Z","file":"a.ts"}', '{"kind":"write","at":"2026-10-12T11:12:00Z","files":["src/x.ts",".coherence/runs/r.jsonl"]}', 'not json'].join('\n'))
  expect(writes).toEqual([{ at: '2026-10-12T11:12:00Z', files: ['src/x.ts', '.coherence/runs/r.jsonl'] }])
  const told = entriesOf(RECORDS, commitsOf(LOG), writes)
  expect(told[1]?.from).toEqual(['written'])
  expect(told[1]?.pings).toEqual([{ path: 'src/x.ts', kind: 'edit' }])
})

test("a record reads in the lexicon's verb and its own words; the headline counts what waits on the person", async () => {
  const told = entriesOf(RECORDS, commitsOf(LOG), [])
  const decided = told[1]
  expect(verbOf('decision')).toBe('decided')
  expect(verbOf('escalation')).toBe('needs you')
  expect(decided === undefined ? undefined : wordsOf(decided)).toEqual({
    head: 'CI runs the unit tests in two shards',
    lines: [
      { label: 'over', text: 'one verify job running npm test' },
      { label: 'because', text: 'the unit step is bound by the runner cores' },
    ],
  })
  expect(told[2] === undefined ? [] : wordsOf(told[2]).lines).toEqual([{ label: 'you said', text: 'keep the fixtures' }])
  expect(headlineOf(told, 0)).toBe('2 decisions · 1 defect · nothing waiting on you')
  expect(headlineOf(told, 1)).toBe('2 decisions · 1 defect · 1 waiting on you')
  expect(sessionOf('8efd', [`${SESSION}.jsonl`, 'other.jsonl'])).toBe(SESSION)
  expect(treeOf(told[1]?.pings ?? []).map(l => `${l.guide}${l.text}`)).toEqual(['.github/workflows/', '└─ ci.yml', 'src/readings/scope/', '└─ both-ways.ts', 'package.json'])
})

/** The engine beneath the mod: a session in /p whose journal holds RECORDS, read through a Coherence CLI at /coh. */
function engine(on: On, journalSize: () => number = () => 10): { ran: string[][]; opened: string[] } {
  const ran: string[][] = []
  const opened: string[] = []
  mock.env(on, { COHERENCE_HOME: '/coh' })
  on('session.root', () => ({ value: '/p' }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/p' }))
  on('fs.stat', ($, e) =>
    e.path === '/coh/src/cli.ts'
      ? { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false, realPath: '/coh/src/cli.ts' } }
      : e.path.startsWith('/p/.coherence/journal/')
        ? { value: { kind: 'file' as const, size: journalSize(), mtimeMs: journalSize(), isLink: false } }
        : Promise.reject(new Error('ENOENT')),
  )
  on('fs.list', () => ({ value: [{ name: `${SESSION}.jsonl`, kind: 'file' as const }] }) as never)
  on('fs.read', () => Promise.reject(new Error('ENOENT')))
  on('fs.write', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: undefined }) as never)
  mock.clock(on)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [{ id: 'coherence-journal', title: 'Journal', isShown: true, isFocused: false, isPlaced: true }] }) as never)
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.scroll', () => ({}))
  on('process.spawn', async function* () {
    await new Promise(() => {})
  })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const stdout = e.argv.includes('journal') ? JSON.stringify({ records: RECORDS, escalations: [] }) : e.argv[0] === 'git' ? LOG : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('classic.SessionStart', () => ({}))
  return { ran, opened }
}

const PANE = { plugin: 'coherence', surface: 'terminal' as const, component: 'Pane' as const, requestId: 'coherence-journal', props: { title: 'Journal', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } } as never }

test("the band's Journal button sits beside Scope, and a press opens the pane on the session's journal", async ($, on) => {
  const { opened, ran } = engine(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  const band = await $.ui.mount({ plugin: 'coherence', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  const buttons = JSON.stringify(await band.findAll({ type: 'Button' }))
  expect(buttons).toContain('Scope ↗')
  expect(buttons).toContain('Journal')
  await band.press({ key: 'journal' })
  expect(opened).toContain('coherence-journal')
  expect(ran.some(argv => argv.includes('journal'))).toBe(true)
  await band.unmount()
})

test("the pane tells the session's journal, each record over its tree, its words folded behind the verb", async ($, on) => {
  const { ran } = engine(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  const pane = await $.ui.mount(PANE)
  await $.tool.call({ tool: 'mcp__coherence__journal' } as never)
  expect(ran.some(argv => argv.join(' ') === `node --disable-warning=ExperimentalWarning /coh/src/cli.ts journal --session ${SESSION} --json`)).toBe(true)
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('journal of 8efd6465')
  expect(drawn).toContain('2 decisions · 1 defect · nothing waiting on you')
  expect(drawn).toContain('found')
  expect(drawn).toContain('decided')
  expect(drawn).toContain('ci.yml ✎')
  expect(drawn).not.toContain('the unit step is bound by the runner cores')
  await pane.press({ key: 'rec-d-de52921c-open' })
  expect(JSON.stringify(await pane.drawn())).toContain('the unit step is bound by the runner cores')
  await pane.unmount()
})

test('the agent opens a record for the person through its tool', async ($, on) => {
  engine(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  const pane = await $.ui.mount(PANE)
  const said = await $.tool.call({ tool: 'mcp__coherence__journal', session: '8efd', open: ['d-3af1ab42'] } as never)
  expect(JSON.stringify(said)).toContain(`The Journal pane shows ${SESSION}: 3 records, 2 decisions · 1 defect · nothing waiting on you. opened d-3af1ab42.`)
  expect(JSON.stringify(await pane.drawn())).toContain('keep the fixtures')
  await pane.unmount()
})

test('a record written while the pane is open lands in it after the Bash call that wrote it', async ($, on) => {
  let size = 10
  const { ran } = engine(on, () => size)
  on('tool.call', () => ({ result: {} }))
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  const pane = await $.ui.mount(PANE)
  await $.tool.call({ tool: 'mcp__coherence__journal' } as never)
  const reads = (): number => ran.filter(argv => argv.includes('journal')).length
  const before = reads()
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  for (let i = 0; i < 200; i++) await Promise.resolve()
  expect(reads()).toBe(before)
  size = 20
  await $.tool.call({ tool: 'Bash', command: 'node src/cli.ts decide x --because y' } as never)
  for (let i = 0; i < 2000 && reads() === before; i++) await Promise.resolve()
  expect(reads()).toBe(before + 1)
  await pane.unmount()
})
