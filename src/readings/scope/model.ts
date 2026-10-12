import type { Attention, Coverage, VocabularyTerm } from "../../lifecycle/lexicon-coverage.ts";
/**
 * The model for the Scope reading: the shape of everything the page handles.
 *
 * The model is a layer of indirection between a lexicon file and the render.
 * Fields can be added to a concept, a lexicon, a layer, or the shell without
 * restructuring the code that carries them; every render takes a model value,
 * never a bare string or number pulled out of one. Fields the page does not
 * show still belong here: a concept's record and a lexicon's record keep
 * every key the file said, so nothing is lost between the file and the page.
 *
 * A concept is split three ways. Its vocabulary is what a definition needs:
 * name, definition, status, aliases, rejected alternatives with their because,
 * distinctions, properties, related names, open questions. Its detail is
 * definitional sub-structure. Its provenance is history: who defined it, the
 * owner's words, the metaphor, the evidence. The page shows vocabulary on the
 * card and keeps detail and provenance one click away, each under its own
 * name, so history is never mistaken for definition.
 *
 * State is a concrete value of this shape. The page holds exactly one
 * `ShellState` and derives everything it shows from it.
 */

/** One alternative that was considered for a concept and refused, with why. */
export interface RejectedAlternative {
  alternative: string;
  because: string;
}

/** A value inside a record: prose, a list, or a nested record. */
export type RecordValue =
  | string
  | number
  | boolean
  | null
  | RecordValue[]
  | { [key: string]: RecordValue };

/** A record of named values, in file order. */
export type Fields = Record<string, RecordValue>;

/**
 * One concept. The vocabulary keys are the ones the card renders in the open;
 * `detail` and `provenance` are the file's own sub-objects, kept whole; every
 * other key on the JSON object is kept in `record`. Coherence's lexicon and
 * a project domain lexicon both parse into this: a project lexicon in an
 * older shape has no detail or provenance, and its extra keys land in record.
 */
export interface Concept {
  name: string;
  definition: string;
  /** Absent when the lexicon records no status for the concept. */
  status?: string;
  /** Names the concept also goes by. */
  aliases: string[];
  instances?: string[];
  rejected: RejectedAlternative[];
  not_to_be_confused_with: string[];
  /** Named properties the definition relies on, each a short statement. */
  properties: Fields;
  related: string[];
  open_questions: string[];
  /** Definitional sub-structure: nested prose, lists and objects. Empty when the file has none. */
  detail: Fields;
  /** History: owner_words, metaphor, evidence, defined_by and similar. Empty when the file has none. */
  provenance: Fields;
  /** Every other field of the entry, in file order. */
  record: Fields;
}

/** Named metaphors that several concepts lean on, keyed by their short name. */
export type Metaphors = Record<string, string>;

/** One name a project lexicon refuses at the top level, with why. Distinct from a concept's rejected alternatives. */
export interface RejectedName {
  concept: string;
  because: string;
  decided_by?: string;
}

/** One entry in the short list a project declares for crossings: an instance of Coherence's trust level. */
export interface TrustLevel {
  name: string;
  meaning: string;
  /** Whether it comes from outside the system's control, as the entry spec marks it; absent reads as inside. */
  outside?: boolean;
}

/** A ruling on a term: how a contested or uncertain name is to be used. */
export interface Ruling {
  term: string;
  ruling: string;
  decided_by?: string;
}

/** A term found carrying more than one sense, with the senses and where each lives. */
export interface Overload {
  term: string;
  senses: string[];
  where?: string;
  ruling?: string;
}

/** One lexicon file, parsed. Coherence's own and a project's share this shape. */
export interface Lexicon {
  version: number;
  project?: string;
  status?: string;
  purpose?: string;
  source?: string;
  completed?: string;
  concepts: Concept[];
  metaphors: Metaphors;
  /** The file's own account of how a concept is split. Kept, never rendered. */
  shape?: Fields;
  /** Undefined when the file does not speak of them; empty when it says there are none. */
  rejected_names?: RejectedName[];
  /** Concepts the lexicon retired, each as it stood, with why it left. */
  retired?: Concept[];
  trust_levels?: TrustLevel[];
  rulings?: Ruling[];
  candidate_overloads?: Overload[];
  uncertain?: Ruling[];
  /** Every other top-level field of the file, in file order. */
  record: Fields;
}

/**
 * One layer of the two-layer lexicon. A layer is either present with its
 * lexicon, or absent with the reason, so absence is a rendered fact rather
 * than a missing element.
 */
export type Layer =
  | { kind: "present"; id: string; title: string; lexicon: Lexicon }
  | { kind: "absent"; id: string; title: string; because: string };

/** A term's evidence may be sampled, but these counts always describe its full reading. */
export interface LexiconEvidenceTerm extends VocabularyTerm {
  contextCount?: number;
  unreviewedContextCount?: number;
}

/** A page projection keeps the authoritative totals and fingerprint, never recasts a sample as a corpus. */
export interface LexiconCoverage extends Coverage {
  terms: LexiconEvidenceTerm[];
  /**
   * The ranked signal the view leads with, computed from the full reading by
   * coverage's own attention rule and cut to its head: the recurring terms
   * that lack a definition, most recurring first, then the senses at risk.
   * `more` says a list was cut, never by how much. Absent only on a full,
   * unprojected reading.
   */
  attention?: Attention & { more: { undefinedTerms: boolean; senses: boolean } };
  /** Absent only on a full, unprojected reading. */
  projection?: {
    byteLimit: number;
    selection: string;
    contexts: number;
    population: { files: number; excluded: number; unreadable: number };
  };
}

/** A copyable full-reading command; quoting keeps corpus text from becoming shell syntax. */
export function lexiconReviewCommand(term: string): string {
  return `coherence lexicon review '${term.replace(/'/g, "'\\''")}' --json`;
}

/** The state of the Lexicon view: the layers it reads and the reader's query. */
export interface LexiconViewState {
  coverage?: LexiconCoverage;
  layers: Layer[];
  query: string;
}

/** Identity of one view in the Scope shell. Adding a view adds a member here. */
export interface ViewIdentity {
  id: string;
  label: string;
}

/*
 * The spec model, as the page carries it. These shapes mirror what
 * `loadSpecModel` in src/spec returns, minus the machine's absolute root, so
 * the browser bundle reads them without importing the tool's own modules.
 * Every field is the tool's own fact; the views derive the rest.
 */

export type SpecEnforcement =
  | { form: "chokepoint"; protects: string; chokepoint: string; line: number; from?: ChokepointFrom }
  | { form: "totality oracle"; over: string; via: string; line: number };

export interface SpecRefutation {
  broke: string;
  saw: string;
  date: string;
  line: number;
}

export interface SpecCrossing {
  from: string;
  to: string;
  line: number;
}

export type SpecChecklistLine =
  | { shape: string; outcome: "declared"; as: string; line: number }
  | { shape: string; outcome: "dismissed"; reason: string; line: number };

/** The lifecycle state of a bullet, as src/spec derives it. */
export type LifecycleState = "requirement" | "invariant" | "structural defect";

export type Lack = "enforcement" | "refutation" | "kinds" | "checklist" | "because";

export type { Form, Verdict, Grade, Governed, RefutationState, Bypass, RecordedSite, ReferenceForm, ReferenceTarget, RunEntry, RunRecord, SiteClass } from "../../enforcement/record.ts";
import type { ChokepointFrom } from "../../spec/grammar.ts";
import type { Bypass, Form, Grade, RecordedSite, RefutationState, RunEntry, RunRecord, Verdict } from "../../enforcement/record.ts";

/**
 * Reference sites of one entry a page does not carry, counted by what every
 * derivation over sites reads: the component the site is in (null for none),
 * the endpoint, the class and the test mark. Set only by a page's window on a
 * latest chokepoint entry, beside the sites it carries; never written to a run.
 */
export interface SiteTally {
  component: string | null;
  of: RecordedSite["of"];
  class: RecordedSite["class"];
  test: boolean;
  count: number;
}

/** A run entry with the run it came from: the latest verdict for one enforcement. */
export interface LatestEntry extends RunEntry {
  at: string;
  commit: string | null;
  session: string;
  /** On a page: the entry's sites the window left out, counted (see SiteTally). Absent when the page carries every site. */
  sitesLeft?: SiteTally[];
}

export interface SpecInvariant {
  name: string;
  sentence: string;
  line: number;
  enforcements: SpecEnforcement[];
  because: string | undefined;
  crossing: SpecCrossing | undefined;
  /** The entrances it names as covered (an entrances: line), as written; absent when it names none, and it covers no entrance by its crossing alone. */
  entrances?: { names: string[] | "none"; line: number } | undefined;
  refutations: SpecRefutation[];
  kinds: string[] | "none" | undefined;
  checklist: SpecChecklistLine[];
  unfilled: string[];
  /** The folder of the component the bullet lives in. */
  component: string;
  applicable: string[];
  missingShapes: string[];
  state: LifecycleState;
  lacks: Lack[];
  /*
   * No latest, verified, or defects here. Those are the run records read by
   * enforcement and invariant name, and the run records are already in this
   * state; a stored copy beside them is a second truth that can disagree.
   * derive.ts computes them at render: latestOf, verifiedOf, defectsOf.
   */
}

/** Where work enters the system through a component, as its spec declares it. */
export interface SpecEntrance {
  name: string;
  meaning: string;
  handler: string | undefined;
  line: number;
  handlerLine: number;
  /** The trust level it declares it carries in; absent when it declares none, and its trust is derived. */
  trust?: string | undefined;
  trustLine?: number | undefined;
  /** The chokepoint it declares its handler is registered through (a guard: line); absent when it declares none. */
  guard?: string | undefined;
  guardLine?: number | undefined;
  /** Why it needs no control (a control: none — <reason> line); absent when it declares none. */
  noControl?: string | undefined;
  controlLine?: number | undefined;
  component: string;
  /** The file whose top level declares the handler (a module handler: the module itself), as the spec model found it. */
  file: string | undefined;
}

export interface SpecComponent {
  /** Relative to the root, with "." for the root itself. */
  folder: string;
  name: string;
  specPath: string;
  intent: string;
  /** Who owns it, as the spec's owners: line declares; absent when it declares none. */
  owners?: string[] | undefined;
  trustLevels: TrustLevel[] | undefined;
  entrances: SpecEntrance[];
  invariants: SpecInvariant[];
  /** The practice file paired with the spec, when there is one; its practices are in the state's practices. */
  practicePath?: string | undefined;
  parent: string | undefined;
  children: string[];
}

export interface SpecProblem {
  file: string;
  line: number;
  message: string;
}

export interface SpecCounts {
  components: number;
  bullets: number;
  invariants: number;
  requirements: number;
  structuralDefects: number;
  lacking: Record<Lack, number>;
  unfilled: number;
  problems: number;
}

/** One rung of the chokepoint grade ladder and who enforces it. */
export interface LadderRung {
  grade: Grade;
  enforcedBy: string;
}

/** The ladder the project's language adapter defines, top rung first. */
export interface Ladder {
  language: string;
  rungs: LadderRung[];
}

export interface SpecData {
  /** The entry component's folder, when a spec is there. */
  entry: string | undefined;
  trustLevels: TrustLevel[];
  components: SpecComponent[];
  problems: SpecProblem[];
  counts: SpecCounts;
  ladder: Ladder;
}


/** A line of a record file that would not parse, reported and never dropped. */
export interface Damaged {
  file: string;
  line: number;
  reason: string;
}

export interface RunsData {
  /** Oldest first, as the loader orders them. On a page, a bounded window of them (see `omitted`). */
  records: RunRecord[];
  damaged: Damaged[];
  /**
   * How many older run records the page does not embed. The window keeps the
   * latest runs and every run that holds some enforcement's latest entry, so
   * every verdict derived from `records` is the one derived from all of them.
   * Absent when nothing was left out.
   */
  omitted?: number;
  /**
   * For an older run the window keeps only for the latest entries it holds,
   * the verdicts of its other entries, which later runs superseded, as
   * counts, by run id: the run's totals stay true without embedding them.
   */
  superseded?: Record<string, { pass: number; fail: number; notRun: number }>;
}

/** A run entry as a page may carry it: the window can leave some of a latest chokepoint entry's sites out, counted. */
export type PageEntry = RunEntry & { sitesLeft?: SiteTally[] };

/* The journal, as src/journal records it. */

import type { Kind } from "../../journal/kinds.ts";

/** The journal's kinds, as its minter's table names them: a kind added there is one every Record<JournalKind, …> here must name. */
export type JournalKind = Kind;

export interface JournalHead {
  id: string;
  kind: JournalKind;
  at: string;
  session: string;
  agent: string;
  work?: string;
  commit: string | null;
  dirty: boolean;
  /** The ids of earlier records, in either store, this record cites; absent when it cites none. */
  cites?: string[];
  /** Words the writing agent attributes to a human (decision, escalation, acknowledgement); not proof a human wrote them. */
  human?: string;
}

export interface JournalStep {
  id: string;
  text: string;
}

export type JournalRecord =
  | (JournalHead & { kind: "decision"; chose: string; over: string[] | "none"; because: string })
  | (JournalHead & { kind: "retraction"; of: string; because: string })
  | (JournalHead & { kind: "conjecture"; observation: string; couldBe: string[]; discriminatedBy: string })
  | (JournalHead & { kind: "resolution"; of: string; because: string; as?: string })
  | (JournalHead & { kind: "dismissal"; of: string; because: string })
  | (JournalHead & { kind: "defect"; what: string; evidence: string; files: string[] })
  | (JournalHead & { kind: "experiment"; expectation: string; context: string[]; actions: JournalStep[]; criteria: JournalStep[] })
  | (JournalHead & { kind: "close"; of: string; results: Record<string, "pass" | "fail" | "unknown">; outcome: "success" | "failure" | "inconclusive" })
  | (JournalHead & { kind: "unable"; what: string; because: string })
  | (JournalHead & { kind: "escalation"; what: string; because: string })
  | (JournalHead & { kind: "acknowledgement"; of: string; because: string })
  | (JournalHead & { kind: "enactment"; practice: string; version: string; trigger: string; steps: { text: string; leaves?: string }[]; pitfalls: string[]; results: Record<string, JournalStepOutcome> });

/** What one step of an enacted practice came to. */
export type JournalStepOutcome = { result: "done"; evidence?: string } | { result: "deviated"; because: string } | { result: "skipped"; because: string };

/**
 * One work order as the journal folds it from its records: the order's
 * content, its owner now, its current state, and the records that moved it.
 * The shape is the journal's own; the page never re-derives an order from
 * the raw store.
 */
import type { WorkOrder } from "../../journal/work.ts";
import type { EntranceCandidate } from "../../adapters/entrance-candidates.ts";
import type { LanguagesRead } from "./languages-read.ts";
export type { WorkOrder };

/** The work orders under .coherence/work, or their absence with the reason. */
export type WorkData =
  | { kind: "present"; orders: WorkOrder[]; damaged: Damaged[] }
  | { kind: "absent"; because: string };

export interface JournalData {
  /** Oldest first, as the loader orders them. On a page, a bounded window of them (see `omitted`). */
  records: JournalRecord[];
  damaged: Damaged[];
  work: WorkData;
  /**
   * How many records the page does not embed. The window keeps the latest
   * records, every open escalation, every record a kept record points at,
   * and (up to a cap) every record a kept record or a work order cites; the
   * whole journal is one `journal` command away. Absent when nothing was
   * left out.
   */
  omitted?: number;
}

/* The reader's state per view: a query and, where the view filters, the filter. */

export interface ComponentsViewState {
  query: string;
  /** The folder of the selected component, whose invariants are shown. Absent until the reader selects one. */
  selected?: string;
}

export interface InvariantsViewState {
  query: string;
  /** "" for every state. */
  state: LifecycleState | "";
  /** A component folder, or "" for every component. */
  component: string;
}

/**
 * One symbol a component interface carries: declared at the top level of a
 * file in `to`, and referenced from non-test code in `from`, as the language
 * adapter resolved it. A component interface is every such symbol for one
 * ordered pair of components.
 */
export interface InterfaceSymbol {
  from: string;
  to: string;
  symbol: string;
  /** The project-relative file whose top level declares the symbol. */
  file: string;
  /** How many non-test reference sites in `from` resolve to it. */
  sites: number;
  /** Present when the symbol declares a type only (an interface or a type alias): a structural route never follows it. */
  kind?: "type";
}

/** One component interface a handler's static reach uses: a reached declaration in `from` referencing a value declaration in `to`. */
export interface ReachReference {
  from: string;
  to: string;
  symbol: string;
  file: string;
  sites: number;
}

/** An entrance's handler as the language adapter resolved it. */
export interface EntranceResolution {
  component: string;
  name: string;
  /** The project-relative file of the handler's definition, when it resolved. */
  file?: string;
  /** Why it did not resolve, when it did not. */
  reason?: string;
  /** The component interfaces the handler's static reach uses, through value references only; absent from a reading taken before reach was read. */
  reach?: ReachReference[];
  /**
   * The chokepoints the handler passes, as the reading traced them: `wrapper`
   * when the handler's own declaration references the chokepoint and its reach
   * reaches the protected thing (the handler is wrapped by it); `declared` when
   * the entrance's guard: line names it and a reference to the handler at its
   * registration spells it; `reach` when the reach reaches the protected thing
   * further on. Only chokepoints whose protected thing the reach reaches count
   * (a declared guard's is reached through the chokepoint itself). Absent from
   * a reading taken before guards were traced.
   */
  guards?: EntranceGuard[];
  /** Why a declared guard did not count, when it did not: no registration of the handler spells it. */
  guardUnconfirmed?: string;
}

/** One chokepoint an entrance's handler passes, by its invariant, and how the reading traced it. */
export interface EntranceGuard {
  component: string;
  name: string;
  how: "wrapper" | "declared" | "reach";
}

/**
 * The reading of every component interface, taken through the language
 * adapter when the page was built. `unread` when no instrument was asked (a
 * test, a preview) or none answered; Structure then reads only the references
 * the latest runs recorded and says so. The shape is what a run could record
 * per commit, which is how two states become comparable.
 */
export interface InterfacePartial {
  /** The budget that was spent. */
  limit: "time" | "memory";
  /** The budget, as a reader reads it: "600 s", "12288 MB". */
  budget: string;
  /** The memory the language server held when the memory budget stopped the reading. */
  observed?: string;
  /** How long the reading ran. */
  seconds: number;
  /** Component folders whose declarations were not all read. */
  unread: string[];
}

export type InterfaceReading =
  | {
      kind: "read";
      language: string;
      /**
       * Which of the project's declared languages the reading read, each through its own adapter, and each one it
       * did not read with why. Every reading taken now carries it; absent only from one recorded before.
       */
      languages?: LanguagesRead;
      declarations: number;
      symbols: InterfaceSymbol[];
      entrances: EntranceResolution[];
      /** Non-test source under no component's folder: code no spec owns, shown as its own mass. */
      unowned: { files: number; lines: number };
      /**
       * What the reading was bounded to: the declared components, the files of
       * component code the word index read, the declarations another
       * component's text could reference (the candidates), and every
       * declaration asked, the reach's included. Absent from a reading taken
       * before the reading was bounded.
       */
      bounds?: { components: number; files: number; candidates: number; asked: number };
      /** Reference sites from code outside every declared component (no component, or past the config's bounds), by callee: counted, never drawn. */
      outside?: { sites: number; files: number; into: { component: string; sites: number }[] };
      /** Present when a budget stopped the reading: which budget, its size, and the components whose declarations were not all read. */
      partial?: InterfacePartial;
      /** The entrances the language's rules detect in the tree, each with its rule and why: what the declared entrances' coverage is measured against. Absent from a reading taken before detection. */
      candidates?: EntranceCandidate[];
      /** Present when the reading was scoped to some entrances' routes rather than read whole: never recorded as the tree's reading. */
      scoped?: ScopedReading;
      /** What the reading did with the language server's kept answers (kept-answers.ts): absent from a reading taken before they were kept. */
      kept?: KeptReport;
    }
  | { kind: "unread"; because: string };

/**
 * What a reading did with the kept answers: how many it reused without
 * asking the server, how many it asked anew, how many files had changed
 * since they were kept and how many answers those changes dropped, and,
 * when nothing kept was used at all, why.
 */
export interface KeptReport {
  reused: number;
  asked: number;
  changed: number;
  dropped: number;
  /** Why nothing kept from an earlier reading was used, when nothing was: every question was asked. */
  whole?: string;
  /** In a reading of several languages that reused some: each language that used nothing kept, with why. */
  unused?: string[];
}

/**
 * What a scoped reading read: the entrances it started from (the named ones
 * and every entrance declared where one of them is, the only ones that can
 * share their routes), the components whose interfaces it read whole (where
 * those entrances are declared and handled, and every component their reach
 * enters), and, into every other component, each caller the word index says
 * could reference it: an interface that may exist, never asked.
 */
export interface ScopedReading {
  entrances: { component: string; name: string }[];
  components: string[];
  maybe: { from: string; to: string }[];
}

/** One proposed crossing added to an ephemeral Structure page, never to the spec model. */
export interface StructurePreview {
  component: string;
  name: string;
  crossing: { from: string; to: string };
  chokepoints?: { chokepoint: string; protects: string }[];
}

/** Structure has no filters: an optional generated-page preview, and what the reader selected in the flow. */
export interface StructureViewState {
  preview: StructurePreview[];
  /** A flow id (an entrance, a trust level, a component, a component interface, a chokepoint) whose story is lit. Absent until the reader selects one. */
  selected?: string;
  /** Component folders opened in place, one level of the tree at a time. Absent: the top level is open. */
  expanded?: string[];
}

export interface RunsViewState {
  query: string;
}

export interface JournalViewState {
  query: string;
  kind: JournalKind | "";
  agent: string;
  session: string;
}

/* Practices, as the spec model and Coherence's kernel hold them. */

/** What fires a practice: a command's words, an edited path's glob with the text the edit adds, or nothing but a deliberate choice. */
export type PracticeTrigger = { kind: "command"; words: string } | { kind: "edit"; glob: string; adding?: string | undefined } | { kind: "explicit" };

/**
 * One practice as the page holds it: the project's own, from a practice file
 * paired with a spec, or a kernel practice Coherence ships, its id led by
 * coherence:. State and enactment count come from the spec model; the
 * enactments themselves are journal records the page already holds.
 */
export interface ScopePractice {
  id: string;
  name: string;
  sentence: string;
  /** The component folder whose practice file holds it. */
  component: string;
  file: string;
  kernel: boolean;
  reach?: "kernel" | "internal" | undefined;
  triggers: PracticeTrigger[];
  steps: { n: number; text: string; leaves?: string | undefined }[];
  pitfalls: { text: string; cites: string[] }[];
  learned: string[];
  invariants: string[];
  because?: string | undefined;
  version: string;
  state: "candidate" | "established";
  enactments: number;
}

export interface PracticesData {
  practices: ScopePractice[];
}

export interface PracticesViewState {
  query: string;
}

/** The whole state of the Scope shell. The page is a function of this value. */
export interface ShellState {
  project: string;
  views: ViewIdentity[];
  activeView: string;
  lexicon: LexiconViewState;
  spec: SpecData;
  runs: RunsData;
  journal: JournalData;
  /** Every component interface, as the language adapter resolved the references when the page was built. */
  componentInterfaces: InterfaceReading;
  components: ComponentsViewState;
  structure: StructureViewState;
  invariants: InvariantsViewState;
  /** Every practice a session here may enact: the project's own and the kernel practices. */
  practices: PracticesData;
  practicesView: PracticesViewState;
  runsView: RunsViewState;
  journalView: JournalViewState;
  /** How the page holds its state: set by the page, never by the builder, so no snapshot or first load carries it. */
  connection?: ConnectionState;
}

/**
 * Where the page's state comes from and whether it is following the stores:
 * a snapshot file never updates; a live page is connecting, live, or
 * disconnected from its warm server and retrying.
 */
export interface ConnectionState {
  mode: "snapshot" | "live";
  status: "connecting" | "live" | "disconnected";
  /** The version of the snapshot the server last sent, so a reconnect is sent a new one only when it changed. */
  version?: string;
  /** Reconnection attempts since the connection was lost. */
  attempt?: number;
  /** Why the last connection ended, in words. */
  reason?: string;
  /** Where the next page of history starts, per store: the cursor below which records may not be loaded yet. */
  history?: { journal?: string; runs?: string };
}

/** The keys of a concept entry that are vocabulary, detail, or provenance. Everything else is record. */
const CONCEPT_KEYS = new Set([
  "name",
  "definition",
  "status",
  "aliases",
  "instances",
  "rejected",
  "not_to_be_confused_with",
  "properties",
  "related",
  "open_questions",
  "detail",
  "provenance",
]);

/** The top-level keys of a lexicon file that the model has a place for. */
const LEXICON_KEYS = new Set([
  "version",
  "project",
  "status",
  "purpose",
  "source",
  "completed",
  "concepts",
  "metaphors",
  "shape",
  "rejected",
  "retired",
  "trust_levels",
  "rulings",
  "candidate_overloads",
  "uncertain",
]);

class LexiconShapeError extends Error {
  constructor(where: string, message: string) {
    super(`${where}: ${message}`);
    this.name = "LexiconShapeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new LexiconShapeError(where, `${key} must be a string`);
  return value;
}

function optionalStringAt(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new LexiconShapeError(where, `${key} must be a string`);
  return value;
}

function stringListAt(record: Record<string, unknown>, key: string, where: string): string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new LexiconShapeError(where, `${key} must be a list of strings`);
  }
  return value;
}

function optionalListAt<T>(
  record: Record<string, unknown>,
  key: string,
  where: string,
  parse: (item: unknown, at: string) => T,
): T[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new LexiconShapeError(where, `${key} must be a list`);
  return value.map((item, i) => parse(item, `${where} ${key}[${i}]`));
}

function asRecordValue(value: unknown, where: string): RecordValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => asRecordValue(v, `${where}[${i}]`));
  if (isRecord(value)) {
    const out: { [key: string]: RecordValue } = {};
    for (const [k, v] of Object.entries(value)) out[k] = asRecordValue(v, `${where}.${k}`);
    return out;
  }
  throw new LexiconShapeError(where, "unsupported value");
}

/** An object-valued key kept whole, in file order. Empty when the key is absent. */
function fieldsAt(record: Record<string, unknown>, key: string, where: string): Fields {
  const value = record[key];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new LexiconShapeError(where, `${key} must be an object`);
  const fields: Fields = {};
  for (const [k, v] of Object.entries(value)) fields[k] = asRecordValue(v, `${where}.${key}.${k}`);
  return fields;
}

/** Every key not in `known`, kept in file order. */
function restOf(
  value: Record<string, unknown>,
  known: Set<string>,
  where: string,
): Fields {
  const record: Fields = {};
  for (const [key, v] of Object.entries(value)) {
    if (!known.has(key)) record[key] = asRecordValue(v, `${where}.${key}`);
  }
  return record;
}

function parseRejected(value: unknown, where: string): RejectedAlternative[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new LexiconShapeError(where, "rejected must be a list");
  return value.map((entry, i) => {
    const at = `${where}.rejected[${i}]`;
    if (!isRecord(entry)) throw new LexiconShapeError(at, "must be an object");
    return {
      alternative: stringAt(entry, "alternative", at),
      because: stringAt(entry, "because", at),
    };
  });
}

function parseConcept(value: unknown, where: string): Concept {
  if (!isRecord(value)) throw new LexiconShapeError(where, "must be an object");
  const name = stringAt(value, "name", where);
  const at = `${where} (${name})`;
  const concept: Concept = {
    name,
    definition: stringAt(value, "definition", at),
    aliases: stringListAt(value, "aliases", at),
    instances: stringListAt(value, "instances", at),
    rejected: parseRejected(value["rejected"], at),
    not_to_be_confused_with: stringListAt(value, "not_to_be_confused_with", at),
    properties: fieldsAt(value, "properties", at),
    related: stringListAt(value, "related", at),
    open_questions: stringListAt(value, "open_questions", at),
    detail: fieldsAt(value, "detail", at),
    provenance: fieldsAt(value, "provenance", at),
    record: restOf(value, CONCEPT_KEYS, at),
  };
  const status = optionalStringAt(value, "status", at);
  if (status !== undefined) concept.status = status;
  return concept;
}

function parseRejectedName(value: unknown, where: string): RejectedName {
  if (!isRecord(value)) throw new LexiconShapeError(where, "must be an object");
  const rejected: RejectedName = {
    concept: stringAt(value, "concept", where),
    because: stringAt(value, "because", where),
  };
  const decidedBy = optionalStringAt(value, "decided_by", where);
  if (decidedBy !== undefined) rejected.decided_by = decidedBy;
  return rejected;
}

function parseTrustLevel(value: unknown, where: string): TrustLevel {
  if (!isRecord(value)) throw new LexiconShapeError(where, "must be an object");
  return { name: stringAt(value, "name", where), meaning: stringAt(value, "meaning", where) };
}

function parseRuling(value: unknown, where: string): Ruling {
  if (!isRecord(value)) throw new LexiconShapeError(where, "must be an object");
  const ruling: Ruling = { term: stringAt(value, "term", where), ruling: stringAt(value, "ruling", where) };
  const decidedBy = optionalStringAt(value, "decided_by", where);
  if (decidedBy !== undefined) ruling.decided_by = decidedBy;
  return ruling;
}

function parseOverload(value: unknown, where: string): Overload {
  if (!isRecord(value)) throw new LexiconShapeError(where, "must be an object");
  const overload: Overload = {
    term: stringAt(value, "term", where),
    senses: stringListAt(value, "senses", where),
  };
  for (const key of ["where", "ruling"] as const) {
    const v = optionalStringAt(value, key, where);
    if (v !== undefined) overload[key] = v;
  }
  return overload;
}

/**
 * Parse one lexicon file into the model. Refuses with a located message
 * rather than rendering a shape it does not understand.
 */
export function parseLexicon(input: unknown, where: string): Lexicon {
  if (!isRecord(input)) throw new LexiconShapeError(where, "lexicon must be an object");
  const version = input["version"];
  if (typeof version !== "number") throw new LexiconShapeError(where, "version must be a number");
  const conceptsRaw = input["concepts"];
  if (!Array.isArray(conceptsRaw)) throw new LexiconShapeError(where, "concepts must be a list");
  const metaphorsRaw = input["metaphors"] ?? {};
  if (!isRecord(metaphorsRaw)) throw new LexiconShapeError(where, "metaphors must be an object");
  const metaphors: Metaphors = {};
  for (const [k, v] of Object.entries(metaphorsRaw)) {
    if (typeof v !== "string") throw new LexiconShapeError(where, `metaphors.${k} must be a string`);
    metaphors[k] = v;
  }
  const lexicon: Lexicon = {
    version,
    concepts: conceptsRaw.map((c, i) => parseConcept(c, `${where} concepts[${i}]`)),
    metaphors,
    record: restOf(input, LEXICON_KEYS, where),
  };
  for (const key of ["project", "status", "purpose", "source", "completed"] as const) {
    const v = optionalStringAt(input, key, where);
    if (v !== undefined) lexicon[key] = v;
  }
  if (input["shape"] !== undefined) lexicon.shape = fieldsAt(input, "shape", where);
  const rejectedNames = optionalListAt(input, "rejected", where, parseRejectedName);
  if (rejectedNames !== undefined) lexicon.rejected_names = rejectedNames;
  const retired = optionalListAt(input, "retired", where, parseConcept);
  if (retired !== undefined) lexicon.retired = retired;
  const trustLevels = optionalListAt(input, "trust_levels", where, parseTrustLevel);
  if (trustLevels !== undefined) lexicon.trust_levels = trustLevels;
  const rulings = optionalListAt(input, "rulings", where, parseRuling);
  if (rulings !== undefined) lexicon.rulings = rulings;
  const overloads = optionalListAt(input, "candidate_overloads", where, parseOverload);
  if (overloads !== undefined) lexicon.candidate_overloads = overloads;
  const uncertain = optionalListAt(input, "uncertain", where, parseRuling);
  if (uncertain !== undefined) lexicon.uncertain = uncertain;
  return lexicon;
}
