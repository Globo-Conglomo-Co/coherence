/**
 * Defects as a discovery that repays: each one carries its class, where it
 * came in and what caught it, and is closed by a resolution that either names
 * a guard for its whole class or cites a decision saying why fixing the
 * instance suffices.
 *
 * The fields are optional on every record, so a defect written before they
 * existed stays valid; the journal is append-only, so such a defect is
 * classified by a later decision (the classify verb), never edited. What a
 * defect's class, origin and catch are is folded here, oldest first: the
 * defect's own fields, then each classification of it, then its resolution;
 * a field given later overrides one given earlier, a retracted record gives
 * nothing, and a field nobody gave stays absent. Nothing is inferred.
 *
 * A class is declared once, as the property "class <name>" of the defect
 * concept in Coherence's lexicon or the project's own. A defect recorded in a
 * class that a resolution already guarded, after that guard, is a guard
 * failure: the protection was weaker than claimed. A family, declared as the
 * property "family <name>", is a class too broad for one guard (audience: a
 * reader told the wrong thing): each of its defects closes with its own guard
 * or a decision, and no guard of one stands for the rest, so a later defect
 * in a family is never a guard failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JournalError } from "./args.ts";
import { missingCommits } from "./commits.ts";
import { CAUGHT, type Caught, type Decision, type Defect, type DefectOrigin, type JournalRecord, type Resolution } from "./record.ts";

const here = dirname(fileURLToPath(import.meta.url));
const COHERENCE_LEXICON = resolve(here, "..", "..", "docs", "lexicon.json");

/** A class name: lowercase words joined by hyphens. */
const CLASS_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** The property key that declares a class, or a family (a class too broad for one guard), on the defect concept. */
const CLASS_KEY = /^(class|family) ([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const PULL = /^PR #(\d+)$/;

/** The classes a lexicon file declares: its defect concept's properties named "class <name>", and "family <name>" when `families` is set (only those). */
function classesIn(path: string, families = false): string[] {
  try {
    const lexicon = JSON.parse(readFileSync(path, "utf8")) as { concepts?: { name?: unknown; properties?: Record<string, unknown> }[] };
    const defect = (lexicon.concepts ?? []).find((c) => c.name === "defect");
    return Object.keys(defect?.properties ?? {}).flatMap((key) => {
      const match = CLASS_KEY.exec(key);
      return match === null || (families && match[1] !== "family") ? [] : [match[2]!];
    });
  } catch {
    return [];
  }
}

/** The project's own lexicon: the config's lexicon key, else lexicon.json at the root. */
function projectLexiconPath(root: string): string | undefined {
  try {
    const config = JSON.parse(readFileSync(join(root, "coherence.config.json"), "utf8")) as { lexicon?: unknown };
    if (typeof config.lexicon === "string") return isAbsolute(config.lexicon) ? config.lexicon : join(root, config.lexicon);
  } catch {
    // No config, or one that cannot be read: the default place.
  }
  const fallback = join(root, "lexicon.json");
  return existsSync(fallback) ? fallback : undefined;
}

/** Every declared defect class, families included, from Coherence's lexicon and the project's own. */
export function declaredClasses(root: string): Set<string> {
  const project = projectLexiconPath(root);
  return new Set([...classesIn(COHERENCE_LEXICON), ...(project === undefined ? [] : classesIn(project))]);
}

/** The declared classes that are families: too broad for one guard, so none stands for the rest. */
export function declaredFamilies(root: string): Set<string> {
  const project = projectLexiconPath(root);
  return new Set([...classesIn(COHERENCE_LEXICON, true), ...(project === undefined ? [] : classesIn(project, true))]);
}

/**
 * The --class, --introduced and --caught a verb was given, checked: a class
 * must be a declared kebab-case name, introduced a commit git holds, PR #<n>,
 * pre-existing or unknown, and caught one of the closed list. Returns the
 * fields to spread into the record, empty when none was given.
 */
export function originFields(given: { class?: string | undefined; introduced?: string | undefined; caught?: string | undefined }, root: string): DefectOrigin {
  const out: DefectOrigin = {};
  if (given.class !== undefined) {
    const name = given.class.trim();
    if (!CLASS_NAME.test(name)) throw new JournalError(`--class "${given.class}" is not a short kebab-case name (path-identity, silent-skip)`);
    const declared = declaredClasses(root);
    if (!declared.has(name)) {
      throw new JournalError(
        `--class ${name} is declared nowhere; declare it once as the property "class ${name}" of defect: lexicon propose define defect --entry <file holding {"properties": {"class ${name}": "<the shape of the failure>"}}> --because "<why>", then lexicon apply. Declared: ${[...declared].sort().join(", ") || "none"}`,
      );
    }
    out.class = name;
  }
  if (given.introduced !== undefined) {
    const value = given.introduced.trim();
    if (value === "pre-existing" || value === "unknown" || PULL.test(value)) out.introduced = value;
    else if (COMMIT.test(value)) {
      if (missingCommits(root, [value])?.has(value)) throw new JournalError(`--introduced ${value}: no commit by that name in this repository`);
      out.introduced = value;
    } else throw new JournalError(`--introduced "${given.introduced}" reads a commit, PR #<n>, pre-existing or unknown`);
  }
  if (given.caught !== undefined) {
    if (!(CAUGHT as readonly string[]).includes(given.caught)) throw new JournalError(`--caught "${given.caught}" is one of ${CAUGHT.join(", ")}`);
    out.caught = given.caught as Caught;
  }
  return out;
}

/** One defect as the journal now has it: its fields folded from every later record, and the resolution that closed it. */
export interface DefectState {
  id: string;
  at: string;
  what: string;
  class?: string;
  introduced?: string;
  caught?: Caught;
  /** The resolution that closed it, unretracted; absent while it is open. */
  resolution?: Resolution;
}

/** Records some retraction points at. */
function retracted(records: readonly JournalRecord[]): Set<string> {
  return new Set(records.flatMap((r) => (r.kind === "retraction" ? [r.of] : [])));
}

function fold(into: DefectOrigin, from: DefectOrigin): void {
  if (from.class !== undefined) into.class = from.class;
  if (from.introduced !== undefined) into.introduced = from.introduced;
  if (from.caught !== undefined) into.caught = from.caught;
}

/** Every defect in the journal, oldest first, with its class, origin and catch folded and its close, if any. */
export function defectStates(records: readonly JournalRecord[]): DefectState[] {
  const gone = retracted(records);
  const ordered = [...records].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const states = new Map<string, DefectState>();
  for (const record of ordered) {
    if (record.kind === "defect") {
      const d = record as Defect;
      const state: DefectState = { id: d.id, at: d.at, what: d.what };
      fold(state, d);
      states.set(d.id, state);
    } else if (gone.has(record.id)) {
      continue;
    } else if (record.kind === "decision") {
      const c = (record as Decision).classifies;
      const state = c === undefined ? undefined : states.get(c.of);
      if (state !== undefined) fold(state, c!);
    } else if (record.kind === "resolution") {
      const state = states.get(record.of);
      if (state === undefined) continue;
      fold(state, record);
      state.resolution = record;
    }
  }
  return [...states.values()];
}

/** How a guard stands: the invariant exists and its refutation is witnessed, or not. */
export type GuardStanding = "witnessed" | "unwitnessed" | "missing";

export interface DefectFloor {
  recorded: number;
  closed: number;
  /** Closed with a guard whose refutation is witnessed. */
  guarded: number;
  /** Closed with a decision and no standing guard. */
  decided: number;
  /** Closed with neither a standing guard nor a decision, each with why. */
  unguarded: { id: string; resolution: string; why: string }[];
  /** Defects in a class a resolution had already guarded when they were recorded. */
  guardFailures: { id: string; class: string; guard: string; guardedBy: string; resolution: string }[];
  /** Defects whose folded class no lexicon declares. */
  undeclared: { id: string; class: string }[];
}

/**
 * The floor on defects, mirroring the practice floor: every closed defect
 * names a guard whose refutation is witnessed, or a decision; a defect in a
 * class already guarded is a guard failure. Advisory: reported, never a
 * problem, so a session is never refused for a close it cannot reopen.
 */
export function defectFloor(states: readonly DefectState[], standing: (guard: string) => GuardStanding, declared: ReadonlySet<string>, families: ReadonlySet<string> = new Set()): DefectFloor {
  const floor: DefectFloor = { recorded: states.length, closed: 0, guarded: 0, decided: 0, unguarded: [], guardFailures: [], undeclared: [] };
  // The earliest standing guard of each class: when it was recorded, which guard, which defect it closed.
  const guards = new Map<string, { at: string; guard: string; by: string; resolution: string }>();
  for (const s of states) {
    if (s.class !== undefined && !declared.has(s.class)) floor.undeclared.push({ id: s.id, class: s.class });
    const r = s.resolution;
    if (r === undefined) continue;
    floor.closed += 1;
    const stands = r.guard === undefined ? undefined : standing(r.guard);
    if (stands === "witnessed") {
      floor.guarded += 1;
      // A family's guards each answer for their own defect, never for the family.
      if (s.class !== undefined && !families.has(s.class)) {
        const prior = guards.get(s.class);
        if (prior === undefined || r.at < prior.at) guards.set(s.class, { at: r.at, guard: r.guard!, by: s.id, resolution: r.id });
      }
    } else if (r.decision !== undefined) floor.decided += 1;
    else {
      const why =
        r.guard === undefined
          ? "names neither a guard nor a decision"
          : stands === "missing"
            ? `names guard ${r.guard}, which no spec declares, and no decision`
            : `names guard ${r.guard}, whose refutation is not witnessed, and no decision`;
      floor.unguarded.push({ id: s.id, resolution: r.id, why });
    }
  }
  for (const s of states) {
    if (s.class === undefined) continue;
    const g = guards.get(s.class);
    if (g === undefined || g.by === s.id || s.at <= g.at) continue;
    floor.guardFailures.push({ id: s.id, class: s.class, guard: g.guard, guardedBy: g.by, resolution: g.resolution });
  }
  return floor;
}

/** The floor's lines for a report: one count line, then each advisory; none when the journal holds no defect. */
export function defectFloorLines(floor: DefectFloor | undefined): string[] {
  if (floor === undefined || floor.recorded === 0) return [];
  const lines: string[] = [];
  for (const g of floor.guardFailures) lines.push(`GUARD FAILURE  ${g.id} in class ${g.class}, which ${g.guard} has guarded since ${g.resolution} closed ${g.guardedBy}: the guard was weaker than claimed; strengthen it and refute it again`);
  for (const u of floor.unguarded) lines.push(`ADVISORY  ${u.id} closed by ${u.resolution} ${u.why}: a guard for its class (an invariant whose refutation is witnessed) or a decision saying why the fix suffices`);
  for (const u of floor.undeclared) lines.push(`ADVISORY  ${u.id} carries class ${u.class}, which no lexicon declares: lexicon propose define defect with the property "class ${u.class}"`);
  const neither = floor.unguarded.length;
  lines.push(
    `defects: ${floor.recorded} recorded, ${floor.closed} closed (${floor.guarded} guarded, ${floor.decided} decided, ${neither} with neither); ${floor.guardFailures.length} guard failure${floor.guardFailures.length === 1 ? "" : "s"}`,
  );
  return lines;
}
