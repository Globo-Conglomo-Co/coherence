/** The verdict line an edit's check left for one tool call's row, by its tool_use_id. */
export type CoherenceVerdict = { text: string; isFailed: boolean }

/** One path a journal record touched, project-relative: one it changed, or one it only names. */
export type Contact = { path: string; kind: 'read' | 'search' | 'edit' }

/** One journal record as the Journal pane tells it: its own fields that say something, and the files it pinged with where the ping came from. */
export type JournalEntry = {
  id: string
  kind: string
  at: string
  agent: string
  chose?: string
  over?: string[]
  because?: string
  human?: string
  what?: string
  evidence?: string
  observation?: string
  couldBe?: string[]
  discriminatedBy?: string
  expectation?: string
  outcome?: string
  of?: string
  guard?: string
  practice?: string
  cites: string[]
  pings: Contact[]
  /** Where the pings came from: named by the record, written or committed since the record before, or named by what it cites. */
  from: string[]
}

/** The journal the pane shows: one session's records, told, and how many of its escalations still wait on the person. */
export type JournalShown = { session: string; records: JournalEntry[]; waiting: number }

declare module 'claude-code' {
  interface PluginState {
    coherence: {
      verdict: StateFamily<CoherenceVerdict>
      /** The session's journal the Journal pane shows, null until it is opened. */
      journal: JournalShown | null
      /** The records the person or the agent opened in the pane, and the trees drawn in full (`tree:<id>`). */
      journalOpened: string[]
      /** Whether the pane follows the journal's end, and how many records landed while the person read further up. */
      journalView: { following: boolean; unseen: number }
    }
  }
}
