/**
 * How the live page folds what the warm server sends into its one state.
 *
 * The server sends a first load (a windowed state), then updates on an event
 * stream: journal, runs and work appends as the records that are new, a
 * recomputed snapshot when a spec, a lexicon or the config changes, and the
 * component interfaces when the language server has read them again. Every
 * update is merged into the state the page already holds and the page
 * renders again; nothing is kept beside the state.
 *
 * Merging is idempotent: records are keyed (a journal record and a work
 * record by id, a run by its time and session), so a record sent twice is
 * held once, and a catch-up that overlaps what the page holds adds nothing.
 * The cursors a page resumes from are derived from the state, never stored:
 * the latest journal record, the latest run, the latest work record.
 *
 * Shared by the browser bundle and the Node tests; it imports types only.
 */

import type { Damaged, InterfaceReading, JournalRecord, PageEntry, RecordedSite, RunRecord, ShellState, WorkOrder } from "./model.ts";

/** One event off the stream: its name and its data, still JSON text. */
export interface StreamEvent {
  event: string;
  data: string;
}

/**
 * Split the text read so far off an event stream into whole events and the
 * unfinished rest. Comment lines (a leading colon) are the server's
 * keepalive and carry nothing.
 */
export function parseStream(text: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  let rest = text.replace(/\r\n/g, "\n");
  for (let end = rest.indexOf("\n\n"); end !== -1; end = rest.indexOf("\n\n")) {
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

/** A run's key: its time and its session, which together name one record. */
export function runKeyOf(run: RunRecord): string {
  return `${run.at}~${run.session}`;
}

function byTimeThenId(a: { at: string; id: string }, b: { at: string; id: string }): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function byTimeThenSession(a: RunRecord, b: RunRecord): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.session !== b.session) return a.session < b.session ? -1 : 1;
  return 0;
}

/** The cursor of the latest of some records: `<at>~<id>`, as the journal's own cursors are written. */
function latestCursor(items: readonly { at: string; id: string }[]): string {
  let latest: { at: string; id: string } | undefined;
  for (const item of items) if (latest === undefined || byTimeThenId(item, latest) > 0) latest = item;
  return latest === undefined ? "" : `${latest.at}~${latest.id}`;
}

/**
 * Where a page resumes: the latest journal record, run and work record it
 * holds, derived from the state. An empty cursor means from the start: the
 * page holds none, so every record the server has is new to it.
 */
export function cursorsOf(state: ShellState): { journal: string; runs: string; work: string } {
  const runs = state.runs.records.map((run) => ({ at: run.at, id: run.session }));
  const work = state.journal.work.kind === "present" ? state.journal.work.orders.flatMap((order) => [{ at: order.at, id: order.id }, ...order.history.map((h) => ({ at: h.at, id: h.id }))]) : [];
  return { journal: latestCursor(state.journal.records), runs: latestCursor(runs), work: latestCursor(work) };
}

/**
 * Merge journal records into the state, each held once, in the loader's
 * order. `older` marks records fetched from history: they were counted as
 * left out, so the count of what is left out goes down by what they added.
 * Returns how many were new.
 */
export function mergeJournal(state: ShellState, records: readonly JournalRecord[], older = false): number {
  const held = new Set(state.journal.records.map((record) => record.id));
  const added = records.filter((record) => !held.has(record.id) && held.add(record.id));
  if (added.length === 0) return 0;
  state.journal.records = [...state.journal.records, ...added].sort(byTimeThenId);
  if (older && state.journal.omitted !== undefined) {
    const left = state.journal.omitted - added.length;
    if (left > 0) state.journal.omitted = left;
    else delete state.journal.omitted;
  }
  return added.length;
}

/** Merge run records into the state, each held once, oldest first; `older` as for the journal. */
export function mergeRuns(state: ShellState, records: readonly RunRecord[], older = false): number {
  const held = new Set(state.runs.records.map(runKeyOf));
  const added = records.filter((run) => !held.has(runKeyOf(run)) && held.add(runKeyOf(run)));
  if (added.length === 0) return 0;
  state.runs.records = [...state.runs.records, ...added].sort(byTimeThenSession);
  if (older && state.runs.omitted !== undefined) {
    const left = state.runs.omitted - added.length;
    if (left > 0) state.runs.omitted = left;
    else delete state.runs.omitted;
  }
  return added.length;
}

/**
 * Take every reference site of one chokepoint entry, fetched by its run and
 * enforcement, in place of the share the first load carried and the count of
 * the rest. Returns whether the page held that entry.
 */
export function mergeSites(state: ShellState, run: string, component: string, name: string, sites: RecordedSite[]): boolean {
  const record = state.runs.records.find((r) => runKeyOf(r) === run);
  const at = record?.invariants.findIndex((e) => e.component === component && e.name === name && e.form === "chokepoint") ?? -1;
  if (record === undefined || at === -1) return false;
  const { sitesLeft: _left, ...entry } = record.invariants[at] as PageEntry;
  record.invariants = record.invariants.map((e, i) => (i === at ? { ...entry, sites } : e));
  return true;
}

/** Replace the work orders an update names, add the new ones, keep the rest. */
export function mergeWork(state: ShellState, orders: readonly WorkOrder[], damaged: Damaged[]): void {
  const current = state.journal.work.kind === "present" ? state.journal.work.orders : [];
  const named = new Map(orders.map((order) => [order.id, order]));
  const kept = current.map((order) => named.get(order.id) ?? order);
  const fresh = orders.filter((order) => !current.some((known) => known.id === order.id));
  state.journal.work = { kind: "present", orders: [...kept, ...fresh].sort((a, b) => byTimeThenId(a, b)), damaged };
}

/**
 * Take a recomputed snapshot: the model (lexicons, specs, interfaces, work)
 * is replaced, the records the page already holds are kept beside the
 * snapshot's, and the count of what is left out is the snapshot's total less
 * what the page now holds. What the reader chose (the view, queries, filters,
 * a selection) is kept.
 */
export function mergeSnapshot(state: ShellState, incoming: ShellState): void {
  const journalTotal = incoming.journal.records.length + (incoming.journal.omitted ?? 0);
  const runsTotal = incoming.runs.records.length + (incoming.runs.omitted ?? 0);
  state.project = incoming.project;
  state.views = incoming.views;
  state.lexicon = { ...incoming.lexicon, query: state.lexicon.query };
  state.spec = incoming.spec;
  state.componentInterfaces = incoming.componentInterfaces;
  state.structure = { ...state.structure, preview: incoming.structure.preview };
  const journal = { ...incoming.journal, records: state.journal.records };
  delete journal.omitted;
  state.journal = journal;
  const runs = { ...incoming.runs, records: state.runs.records };
  delete runs.omitted;
  state.runs = runs;
  mergeJournal(state, incoming.journal.records);
  mergeRuns(state, incoming.runs.records);
  if (journalTotal > state.journal.records.length) state.journal.omitted = journalTotal - state.journal.records.length;
  if (runsTotal > state.runs.records.length) state.runs.omitted = runsTotal - state.runs.records.length;
}

/**
 * Apply one event from the stream to the state. Returns whether the state
 * changed, so the page renders only when something did. A name it does not
 * know changes nothing.
 */
export function applyUpdate(state: ShellState, event: string, data: unknown): boolean {
  switch (event) {
    case "journal": {
      const update = data as { records: JournalRecord[]; damaged: ShellState["journal"]["damaged"] };
      const added = mergeJournal(state, update.records);
      const damagedChanged = JSON.stringify(update.damaged) !== JSON.stringify(state.journal.damaged);
      if (damagedChanged) state.journal.damaged = update.damaged;
      return added > 0 || damagedChanged;
    }
    case "runs": {
      const update = data as { records: RunRecord[]; damaged: ShellState["runs"]["damaged"] };
      const added = mergeRuns(state, update.records);
      const damagedChanged = JSON.stringify(update.damaged) !== JSON.stringify(state.runs.damaged);
      if (damagedChanged) state.runs.damaged = update.damaged;
      return added > 0 || damagedChanged;
    }
    case "work": {
      const update = data as { orders: WorkOrder[]; damaged: ShellState["journal"]["damaged"] };
      mergeWork(state, update.orders, update.damaged);
      return true;
    }
    case "snapshot": {
      const update = data as { state: ShellState; version: string };
      mergeSnapshot(state, update.state);
      if (state.connection !== undefined) state.connection.version = update.version;
      return true;
    }
    case "interfaces":
      state.componentInterfaces = data as InterfaceReading;
      return true;
    default:
      return false;
  }
}
