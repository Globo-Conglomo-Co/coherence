// A session's journal as the Journal pane tells it: each record in the
// lexicon's verb and its own words, and the files it pinged, with where the
// ping came from. Pure, so the tests hold it without an engine.
//
// A record's files come, in order, from what it names itself (a defect's
// files, an experiment's context), from what the session wrote since its
// record before (the hooks' write trace, else the branch's own commits between
// the two records' commits), and, when it has neither, from what it cites.

import type { Contact, JournalEntry } from '../types'

/** A record as `coherence journal --json` prints it: the fields the pane reads. */
export type Recorded = Record<string, unknown> & { id: string; kind: string; at: string; session: string; agent: string; commit?: string | null; cites?: string[]; files?: string[]; context?: string[] }

/** One commit of the branch's own first-parent line, newest first, and the files it changed. */
export type Committed = { commit: string; files: string[] }

/** One write line of the hooks' trace. */
export type Written = { at: string; files: string[] }

const VERBS: Record<string, string> = {
  decision: 'decided',
  defect: 'found',
  resolution: 'resolved',
  dismissal: 'dismissed',
  retraction: 'retracted',
  conjecture: 'conjectured',
  experiment: 'experiment',
  close: 'closed',
  unable: 'unable',
  escalation: 'needs you',
  acknowledgement: 'acknowledged',
  enactment: 'enacted',
}

/** The verb a record kind reads as; an escalation says it needs the person. */
export function verbOf(kind: string): string {
  return VERBS[kind] ?? kind
}

/** A record's own words: its headline, then the lines under it (what it turned down and why, the owner's words, its candidates). */
export function wordsOf(r: JournalEntry): { head: string; lines: { label: string; text: string }[] } {
  const lines: { label: string; text: string }[] = []
  const add = (label: string, text: string | undefined): void => {
    if (text !== undefined && text.trim() !== '') lines.push({ label, text })
  }
  let head = ''
  switch (r.kind) {
    case 'decision':
      head = r.chose ?? ''
      add('over', r.over?.join('; '))
      add('because', r.because)
      break
    case 'defect':
      head = r.what ?? ''
      add('evidence', r.evidence)
      break
    case 'conjecture':
      head = r.observation ?? ''
      add('could be', r.couldBe?.join(' · '))
      add('told apart by', r.discriminatedBy)
      break
    case 'experiment':
      head = r.expectation ?? ''
      break
    case 'close':
      head = `${r.outcome ?? 'closed'}${r.of === undefined ? '' : ` · ${r.of}`}`
      break
    case 'unable':
    case 'escalation':
      head = r.what ?? ''
      add('because', r.because)
      break
    case 'enactment':
      head = r.practice ?? ''
      break
    default:
      head = r.because ?? r.what ?? ''
      add('guard', r.guard)
  }
  add('you said', r.human)
  return { head, lines }
}

/** Where a record's files came from, as one word for the gutter beside its tree. */
export function sourceOf(from: readonly string[]): string {
  if (from.includes('written') || from.includes('committed')) return 'changed'
  if (from.includes('named')) return 'named'
  if (from.includes('cited')) return 'cited'
  return ''
}

/** The journal's headline: what the session recorded, and how many escalations still wait on the person. */
export function headlineOf(records: readonly JournalEntry[], waiting: number): string {
  const count = (kind: string): number => records.filter(r => r.kind === kind).length
  const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
  return [
    plural(count('decision'), 'decision'),
    plural(count('defect'), 'defect'),
    ...(count('conjecture') > 0 ? [plural(count('conjecture'), 'conjecture')] : []),
    ...(count('experiment') > 0 ? [plural(count('experiment'), 'experiment')] : []),
    waiting > 0 ? `${waiting} waiting on you` : 'nothing waiting on you',
  ].join(' · ')
}

/** A file of the project's own, not Coherence's records or the host's. */
const isProject = (f: string): boolean => f !== '' && !f.startsWith('.coherence/') && !f.startsWith('.claude/')

/** The commits of `git log --first-parent --name-only --format=@%h`, newest first. */
export function commitsOf(log: string): Committed[] {
  const out: Committed[] = []
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) out.push({ commit: line.slice(1).trim(), files: [] })
    else if (line.trim() !== '') out.at(-1)?.files.push(line.trim())
  }
  return out
}

/** The write lines of the hooks' trace for a session. */
export function writesOf(trace: string): Written[] {
  return trace
    .split('\n')
    .filter(l => l.trim() !== '')
    .flatMap(l => {
      try {
        const line = JSON.parse(l) as { kind?: string; at?: string; files?: string[]; file?: string }
        return line.kind === 'write' && typeof line.at === 'string' ? [{ at: line.at, files: line.files ?? (line.file === undefined ? [] : [line.file]) }] : []
      } catch {
        return []
      }
    })
}

/** Whether two commit names are one commit: a short hash and a longer one agree on what they share. */
const same = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a)

/** The files the branch's own commits changed after `from` and up to `to`, on the first-parent line; none when either is off it. */
function changedBetween(chain: readonly Committed[], from: string | null | undefined, to: string | null | undefined): string[] {
  if (from == null || to == null || same(from, to)) return []
  const at = chain.findIndex(c => same(c.commit, to))
  const before = chain.findIndex(c => same(c.commit, from))
  if (at === -1 || before === -1 || at > before) return []
  return chain.slice(at, before).flatMap(c => c.files)
}

/** The records in order, each told: its fields that say something, and the files it pinged with where they came from. */
export function entriesOf(records: readonly Recorded[], chain: readonly Committed[], writes: readonly Written[]): JournalEntry[] {
  const sorted = [...records].filter(r => typeof r.at === 'string').sort((a, b) => a.at.localeCompare(b.at))
  const byId = new Map(sorted.map(r => [r.id, r]))
  const namedBy = (r: Recorded): string[] => [...(Array.isArray(r.files) ? r.files : []), ...(Array.isArray(r.context) ? r.context : [])].filter(isProject)
  return sorted.map((r, i) => {
    const before = sorted[i - 1]
    const named = [...new Set(namedBy(r))]
    const traced = writes.filter(w => (before === undefined || w.at > before.at) && w.at <= r.at).flatMap(w => w.files).filter(isProject)
    const written = [...new Set(traced.length > 0 ? traced : changedBetween(chain, before?.commit, r.commit).filter(isProject))]
    const cited = [...new Set((r.cites ?? []).flatMap(id => {
      const c = byId.get(id)
      return c === undefined ? [] : namedBy(c)
    }))]
    const pings: Contact[] = named.map(path => ({ path, kind: 'read' as const }))
    for (const path of written) if (!named.includes(path)) pings.push({ path, kind: 'edit' })
    const from = named.length > 0 || written.length > 0 ? [...(named.length > 0 ? ['named'] : []), ...(written.length > 0 ? [traced.length > 0 ? 'written' : 'committed'] : [])] : cited.length > 0 ? ['cited'] : []
    if (pings.length === 0) for (const path of cited) pings.push({ path, kind: 'read' })
    const text = (k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined)
    const list = (k: string): string[] | undefined => (Array.isArray(r[k]) ? (r[k] as string[]) : undefined)
    const entry: JournalEntry = { id: r.id, kind: r.kind, at: r.at, agent: r.agent, cites: r.cites ?? [], pings: pings.slice(0, 40), from }
    for (const k of ['chose', 'because', 'human', 'what', 'evidence', 'observation', 'discriminatedBy', 'expectation', 'outcome', 'of', 'guard', 'practice'] as const) {
      const v = text(k)
      if (v !== undefined) entry[k] = v
    }
    const over = list('over')
    if (over !== undefined) entry.over = over
    const couldBe = list('couldBe')
    if (couldBe !== undefined) entry.couldBe = couldBe
    return entry
  })
}

/** The journal session a prefix names among the journal's files, or undefined when none does. */
export function sessionOf(prefix: string, names: readonly string[]): string | undefined {
  return names.map(n => n.replace(/\.jsonl$/, '')).find(n => n.startsWith(prefix))
}
