/**
 * The shape of a journal record.
 *
 * The journal is compression: a session's work, however long, leaves a
 * handful of durable outcomes. Every record carries the same head (id, kind,
 * time, attribution, commit) and then the fields its kind needs. Nothing here
 * is ever edited; a later record points at an earlier one instead.
 */

import { createHash } from "node:crypto";

/** Every kind the journal records, with the id prefix that marks it. */
export const KINDS = {
  decision: "d",
  retraction: "rt",
  conjecture: "c",
  resolution: "rs",
  dismissal: "dm",
  defect: "df",
  experiment: "x",
  close: "xc",
  unable: "u",
  escalation: "e",
  acknowledgement: "ak",
  enactment: "en",
} as const;

export type Kind = keyof typeof KINDS;

export const KIND_NAMES: readonly Kind[] = Object.keys(KINDS) as Kind[];

export function isKind(value: string): value is Kind {
  return Object.hasOwn(KINDS, value);
}

/** The glyph each kind prints in the timeline. */
export const GLYPH: Record<Kind, string> = {
  decision: "◆",
  retraction: "↺",
  conjecture: "?",
  resolution: "✓",
  dismissal: "−",
  defect: "!",
  experiment: "▷",
  close: "▶",
  unable: "⊘",
  escalation: "▲",
  acknowledgement: "△",
  enactment: "◇",
};

/** The candidate every conjecture carries whether or not the caller named it. */
export const INSTRUMENT_IS_WRONG = "the instrument is wrong";

/**
 * The kinds the work store records, with their id prefixes. Work orders live
 * in their own files under .coherence/work; these kinds never appear in the
 * journal, but their ids come from the same minter.
 */
export const WORK_KINDS = {
  order: "w",
  move: "wm",
  owner: "wo",
  completion: "wc",
} as const;

export type WorkKind = keyof typeof WORK_KINDS;

export function isWorkKind(value: string): value is WorkKind {
  return Object.hasOwn(WORK_KINDS, value);
}

/** What every record carries. Session is the key; agent is the readable name. */
export interface Attribution {
  session: string;
  agent: string;
  /** The work order the caller named with --work; absent when binding is inferred at the append. */
  work?: string;
}

/** The head every record in either store shares: id, kind, time, attribution, commit. */
export interface Stamp<K extends string> {
  id: string;
  kind: K;
  /** ISO time of the write. */
  at: string;
  session: string;
  agent: string;
  /** Short sha of HEAD at the write, or null when there is no git to ask. */
  commit: string | null;
  /** Whether the working tree had uncommitted changes at the write. */
  dirty: boolean;
}

/**
 * A citation: the ids of earlier records, in either store and of any kind,
 * that a record rests on or is about. Checked at the write (an id that names
 * no record is refused), never typed, and read back in both directions: what
 * a record cites and what cites it. Absent on records that cite nothing and
 * on every record written before citations existed.
 */
export interface Citing {
  cites?: string[];
}

/**
 * Words the writing agent attributes to a human, kept apart from the agent's
 * own because. It records the attribution, not proof that a human wrote them.
 */
export interface HumanWords {
  human?: string;
}

export interface Head extends Stamp<Kind> {
  /** The work order this record binds to, when it binds to one. */
  work?: string;
  /**
   * How the binding was settled at the append: "flag" when --work named the
   * order, "inferred" when the session owned exactly one active order, or
   * "none: <reason>" when nothing binds. Absent on records older than binding.
   */
  binding?: string;
}

/**
 * A defect's class, where it came in, and what caught it. Each is optional:
 * a record written before these fields existed, or by a caller who did not
 * know, carries none, and every reader says unknown rather than guess.
 */
export interface DefectOrigin {
  /** A short kebab-case name for the shape of the failure, declared once in a lexicon as the property "class <name>" of defect. */
  class?: string;
  /** A commit, "PR #<n>", "pre-existing" or "unknown". */
  introduced?: string;
  caught?: Caught;
}

export const CAUGHT = ["review", "ci", "probe", "adopter", "self", "test"] as const;
export type Caught = (typeof CAUGHT)[number];

export interface Decision extends Head, Citing, HumanWords {
  kind: "decision";
  /**
   * Present on a decision the classify verb wrote: the defect it classifies
   * and the fields it gives, each overriding what the defect and earlier
   * classifications said. The journal is append-only, so a defect recorded
   * without these fields is classified by a later record, never edited.
   */
  classifies?: DefectOrigin & { of: string };
  chose: string;
  /**
   * What was rejected. An empty list means the caller never said; the string
   * "none" means the caller said nothing was rejected. The two are different
   * facts and the record keeps them apart.
   */
  over: string[] | "none";
  because: string;
}

export interface Retraction extends Head {
  kind: "retraction";
  /** The id of the record this retracts. */
  of: string;
  because: string;
}

export interface Conjecture extends Head, Citing {
  kind: "conjecture";
  observation: string;
  couldBe: string[];
  discriminatedBy: string;
}

export interface Resolution extends Head, DefectOrigin {
  kind: "resolution";
  /** The conjecture this resolves, or the defect it closes. */
  of: string;
  because: string;
  /** Which candidate won, when the caller named one; a conjecture's only. */
  as?: string;
  /**
   * A defect's close only: the invariant, as <component folder>/<name>, that
   * guards the defect's whole class. It counts once its refutation is witnessed.
   */
  guard?: string;
  /** A defect's close only: the decision that says why fixing the instance suffices. */
  decision?: string;
}

export interface Dismissal extends Head {
  kind: "dismissal";
  of: string;
  because: string;
}

export interface Defect extends Head, Citing, DefectOrigin {
  kind: "defect";
  what: string;
  evidence: string;
  files: string[];
}

/** One planned action or one observable criterion, with the id its result binds to. */
export interface Step {
  id: string;
  text: string;
}

export interface Experiment extends Head, Citing {
  kind: "experiment";
  expectation: string;
  context: string[];
  actions: Step[];
  criteria: Step[];
}

export type StepResult = "pass" | "fail" | "unknown";
export type Outcome = "success" | "failure" | "inconclusive";

export interface Close extends Head {
  kind: "close";
  of: string;
  results: Record<string, StepResult>;
  outcome: Outcome;
}

export interface Unable extends Head, Citing {
  kind: "unable";
  what: string;
  because: string;
}

export interface Escalation extends Head, Citing, HumanWords {
  kind: "escalation";
  what: string;
  because: string;
}

export interface Acknowledgement extends Head, HumanWords {
  kind: "acknowledgement";
  of: string;
  because: string;
}

/** What one step of an enacted practice came to: done with its evidence, or deviated or skipped with why. */
export type StepOutcome =
  | { result: "done"; evidence?: string }
  | { result: "deviated"; because: string }
  | { result: "skipped"; because: string };

/**
 * A practice carried out: which practice, the version enacted, what fired it,
 * the text of its steps and pitfalls as they stood (so a later change can be
 * read against what was enacted), and an outcome for every step, keyed by the
 * step's number.
 */
export interface Enactment extends Head, Citing {
  kind: "enactment";
  /** The practice's id: its component folder and name, "coherence:" first for Coherence's layer in an adopter. */
  practice: string;
  version: string;
  /** What fired it: a trigger as the hook described it, or explicit. */
  trigger: string;
  steps: { text: string; leaves?: string }[];
  pitfalls: string[];
  results: Record<string, StepOutcome>;
}

export type JournalRecord =
  | Decision
  | Retraction
  | Conjecture
  | Resolution
  | Dismissal
  | Defect
  | Experiment
  | Close
  | Unable
  | Escalation
  | Acknowledgement
  | Enactment;

/**
 * An id is the kind's prefix and eight hex digits of a hash over session,
 * time, and text. Two writers in different sessions never collide; one writer
 * never collides with itself unless it writes the same text twice in the same
 * millisecond, which is the same record.
 */
export function recordId(kind: Kind | WorkKind, session: string, at: string, text: string): string {
  const digest = createHash("sha256").update(`${session}\n${at}\n${text}`).digest("hex");
  const prefix = isKind(kind) ? KINDS[kind] : WORK_KINDS[kind];
  return `${prefix}-${digest.slice(0, 8)}`;
}

/** The outcome an experiment's close derives from its results. */
export function deriveOutcome(results: readonly StepResult[]): Outcome {
  if (results.includes("fail")) return "failure";
  if (results.every((result) => result === "pass")) return "success";
  return "inconclusive";
}

/** The one line that stands for a record in the peer feed. */
export function subjectOf(record: JournalRecord): string {
  switch (record.kind) {
    case "decision":
      return record.chose;
    case "conjecture":
      return record.observation;
    case "defect":
    case "unable":
    case "escalation":
      return record.what;
    case "experiment":
      return record.expectation;
    case "retraction":
      return `retracted ${record.of}`;
    case "resolution":
      return `resolved ${record.of}`;
    case "dismissal":
      return `dismissed ${record.of}`;
    case "close":
      return `closed ${record.of}: ${record.outcome}`;
    case "acknowledgement":
      return `acknowledged ${record.of}`;
    case "enactment":
      return `enacted ${record.practice}: ${enactmentTally(record)}`;
  }
}

/** How an enactment's steps came out, as one phrase: "5 of 6 done, 1 deviated". */
export function enactmentTally(record: Enactment): string {
  const outcomes = Object.values(record.results);
  const count = (result: StepOutcome["result"]): number => outcomes.filter((o) => o.result === result).length;
  const parts = [`${count("done")} of ${outcomes.length} done`];
  if (count("deviated") > 0) parts.push(`${count("deviated")} deviated`);
  if (count("skipped") > 0) parts.push(`${count("skipped")} skipped`);
  return parts.join(", ");
}

/** The states a work order moves through; completed and cancelled end it. */
export const WORK_STATES = ["open", "active", "waiting", "completed", "cancelled"] as const;
export type WorkState = (typeof WORK_STATES)[number];
export const TERMINAL_STATES: readonly WorkState[] = ["completed", "cancelled"];

export function isWorkState(value: string): value is WorkState {
  return (WORK_STATES as readonly string[]).includes(value);
}

/** The order itself: its content and the owner session it starts with. */
export interface WorkOrderRecord extends Stamp<"order">, Citing {
  objective: string;
  success: string;
  boundary: string;
  /** The session that owns the order at creation; the creating session by default. */
  owner: string;
}

/** A move to another state; never to completed, which only close records. */
export interface WorkMove extends Stamp<"move">, Citing {
  of: string;
  state: Exclude<WorkState, "completed">;
  because: string;
}

/** A change of owner session, by anyone, recorded. */
export interface WorkOwner extends Stamp<"owner"> {
  of: string;
  owner: string;
  because: string;
}

/** The close: the only path to completed. */
export interface WorkCompletion extends Stamp<"completion">, Citing {
  of: string;
  state: "completed";
  because: string;
}

export type WorkRecord = WorkOrderRecord | WorkMove | WorkOwner | WorkCompletion;

/** Records that point at an earlier record carry its id in `of`. */
export function pointsAt(record: JournalRecord): string | null {
  switch (record.kind) {
    case "retraction":
    case "resolution":
    case "dismissal":
    case "close":
    case "acknowledgement":
      return record.of;
    default:
      return null;
  }
}

/** A record from either store. */
export type AnyRecord = JournalRecord | WorkRecord;

/** The ids a record cites; empty for a kind that cannot cite and for a record written before citations. */
export function citesOf(record: AnyRecord): readonly string[] {
  const cites = (record as Citing).cites;
  return Array.isArray(cites) ? cites : [];
}

/** The one line that stands for a work record. */
export function workSubjectOf(record: WorkRecord): string {
  switch (record.kind) {
    case "order":
      return record.objective;
    case "move":
      return `${record.of} -> ${record.state}: ${record.because}`;
    case "owner":
      return `${record.of} owner -> ${record.owner}: ${record.because}`;
    case "completion":
      return `${record.of} -> completed: ${record.because}`;
  }
}

/** What a record from either store is called in a line that names it: the journal kind, or the work kind as a work order phrase. */
export function kindLabel(record: AnyRecord): string {
  if (isKind(record.kind)) return record.kind;
  switch (record.kind) {
    case "order":
      return "work order";
    case "move":
      return "work order move";
    case "owner":
      return "work order owner change";
    case "completion":
      return "work order close";
  }
}

/** The subject of a record from either store. */
export function anySubjectOf(record: AnyRecord): string {
  return isKind(record.kind) ? subjectOf(record as JournalRecord) : workSubjectOf(record as WorkRecord);
}

/**
 * What cites each id, across both stores, oldest citer first (time, then
 * id). Computed at every read and stored nowhere, so an old record gains a
 * citer without anything on disk changing.
 */
export function citedBy(records: readonly AnyRecord[]): Map<string, AnyRecord[]> {
  const index = new Map<string, AnyRecord[]>();
  const ordered = [...records].sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const record of ordered) {
    for (const id of citesOf(record)) {
      const list = index.get(id) ?? [];
      list.push(record);
      index.set(id, list);
    }
  }
  return index;
}

/**
 * What a record's field is to a reader of words. "prose" is the writer's own
 * words: read for vocabulary (lexicon coverage) and for rejected names (the
 * vocabulary check). "quoted" is prose that names what the writer turned away
 * (a decision's over): read for vocabulary, never held against the writer.
 * "meta" is bookkeeping, the tool's spelling and never words: ids, sessions,
 * commits, paths, states and enumerated values.
 */
export type WordRole = "prose" | "quoted" | "meta";

/** A field holding records of its own: one object read by its own table (fields), or a list or map of them (each). */
export type NestedRoles = { readonly fields: RoleTable } | { readonly each: RoleTable };

export interface RoleTable {
  readonly [field: string]: WordRole | NestedRoles;
}

/** Every key of every member of a union, where keyof gives only the keys all members share. */
type AnyKey<T> = T extends unknown ? keyof T : never;

/**
 * One role for every field a type can carry, optional ones included. Keyed by
 * the type's own keys, so a field added to a record type without a role, or a
 * role kept for a field the type no longer has, fails to compile.
 */
export type FieldRoles<T> = { readonly [K in AnyKey<T>]-?: WordRole | NestedRoles };

const STAMP_ROLES = { id: "meta", kind: "meta", at: "meta", session: "meta", agent: "meta", commit: "meta", dirty: "meta" } as const satisfies FieldRoles<Stamp<string>>;
const HEAD_ROLES = { ...STAMP_ROLES, work: "meta", binding: "meta" } as const satisfies FieldRoles<Head>;
const CITING_ROLES = { cites: "meta" } as const satisfies FieldRoles<Citing>;
const HUMAN_ROLES = { human: "prose" } as const satisfies FieldRoles<HumanWords>;
/** A class is a name the lexicon declares, so it is read; where a defect came in and what caught it are a commit or a fixed word. */
const ORIGIN_ROLES = { class: "prose", introduced: "meta", caught: "meta" } as const satisfies FieldRoles<DefectOrigin>;
const STEP_ROLES = { id: "meta", text: "prose" } as const satisfies FieldRoles<Step>;
const OUTCOME_ROLES = { result: "meta", evidence: "prose", because: "prose" } as const satisfies FieldRoles<StepOutcome>;

/**
 * The role of every field of every record kind, in both stores, declared once
 * beside the types. The vocabulary check and lexicon coverage both read a
 * record's words through recordWords, which reads these tables; neither keeps
 * a list of field names of its own. Run records have no table: their store
 * holds no prose (stores.ts), and nothing reads a run for words.
 */
export const RECORD_ROLES: { readonly [K in AnyRecord["kind"]]: FieldRoles<Extract<AnyRecord, { kind: K }>> } = {
  decision: { ...HEAD_ROLES, ...CITING_ROLES, ...HUMAN_ROLES, classifies: { fields: { ...ORIGIN_ROLES, of: "meta" } satisfies FieldRoles<NonNullable<Decision["classifies"]>> }, chose: "prose", over: "quoted", because: "prose" },
  retraction: { ...HEAD_ROLES, of: "meta", because: "prose" },
  conjecture: { ...HEAD_ROLES, ...CITING_ROLES, observation: "prose", couldBe: "prose", discriminatedBy: "prose" },
  resolution: { ...HEAD_ROLES, ...ORIGIN_ROLES, of: "meta", because: "prose", as: "prose", guard: "prose", decision: "meta" },
  dismissal: { ...HEAD_ROLES, of: "meta", because: "prose" },
  defect: { ...HEAD_ROLES, ...CITING_ROLES, ...ORIGIN_ROLES, what: "prose", evidence: "prose", files: "meta" },
  experiment: { ...HEAD_ROLES, ...CITING_ROLES, expectation: "prose", context: "prose", actions: { each: STEP_ROLES }, criteria: { each: STEP_ROLES } },
  close: { ...HEAD_ROLES, of: "meta", results: "meta", outcome: "meta" },
  unable: { ...HEAD_ROLES, ...CITING_ROLES, what: "prose", because: "prose" },
  escalation: { ...HEAD_ROLES, ...CITING_ROLES, ...HUMAN_ROLES, what: "prose", because: "prose" },
  acknowledgement: { ...HEAD_ROLES, ...HUMAN_ROLES, of: "meta", because: "prose" },
  enactment: {
    ...HEAD_ROLES,
    ...CITING_ROLES,
    practice: "prose",
    version: "meta",
    trigger: "prose",
    steps: { each: { text: "prose", leaves: "prose" } satisfies FieldRoles<Enactment["steps"][number]> },
    pitfalls: "prose",
    results: { each: OUTCOME_ROLES },
  },
  order: { ...STAMP_ROLES, ...CITING_ROLES, objective: "prose", success: "prose", boundary: "prose", owner: "meta" },
  move: { ...STAMP_ROLES, ...CITING_ROLES, of: "meta", state: "meta", because: "prose" },
  owner: { ...STAMP_ROLES, of: "meta", owner: "meta", because: "prose" },
  completion: { ...STAMP_ROLES, ...CITING_ROLES, of: "meta", state: "meta", because: "prose" },
};

/**
 * The strings of a parsed record a reader of words reads: every string under
 * a field whose role `read` accepts, walked through nested lists and objects.
 * A kind no table names, or a field its table does not, is read as prose
 * apart from the head every record carries: a reader of words never skips
 * what it does not know.
 */
export function recordWords(record: unknown, read: (role: WordRole) => boolean): string[] {
  const out: string[] = [];
  const kind = typeof record === "object" && record !== null ? (record as { kind?: unknown }).kind : undefined;
  const table: RoleTable = typeof kind === "string" && Object.hasOwn(RECORD_ROLES, kind) ? RECORD_ROLES[kind as AnyRecord["kind"]] : HEAD_ROLES;
  walkWords(record, table, read, out);
  return out;
}

function walkWords(value: unknown, table: RoleTable | undefined, read: (role: WordRole) => boolean, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) walkWords(item, table, read, out);
  else if (typeof value === "object" && value !== null) {
    for (const [field, item] of Object.entries(value)) {
      const role = table === undefined || !Object.hasOwn(table, field) ? "prose" : table[field]!;
      if (typeof role === "string") {
        if (read(role)) walkWords(item, undefined, read, out);
      } else if ("fields" in role) walkWords(item, role.fields, read, out);
      else if (Array.isArray(item)) for (const each of item) walkWords(each, role.each, read, out);
      else if (typeof item === "object" && item !== null) for (const each of Object.values(item)) walkWords(each, role.each, read, out);
      else walkWords(item, undefined, read, out);
    }
  }
}
