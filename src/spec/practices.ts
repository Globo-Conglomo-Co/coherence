/**
 * Practices in the model: each practice file paired with its folder's spec,
 * the kernel practices every adopter receives from Coherence, and the
 * checks that keep a practice's integrity.
 *
 * A practice file stands only beside a spec, with the spec's own stem
 * (Enforcement.spec.md, Enforcement.practice.md). Every record or commit a
 * practice cites must exist. An invariant it names must be one its sister
 * spec, or the component it names, declares. And once a practice has been
 * enacted, the text every enactment carried out is the floor: a step or a
 * pitfall that has since left the practice is a problem until a decision,
 * recorded at or after the latest enactment that carried it out, cites an
 * enactment of the practice, names the practice, and says why. Adding a step or a pitfall is free;
 * a candidate (never enacted) may change freely.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRACTICE_SUFFIX, RECORD_ID, globMatches, parsePractices, type Practice } from "./practice.ts";
import { keepProjectFiles, nestedFolder, projectFilesUnder, repositoryTop } from "../adapters/project-files.ts";
import type { Problem } from "./grammar.ts";
import { loadJournal } from "../journal/store.ts";
import { loadWork } from "../journal/work.ts";
import { recordsOnOtherBranches } from "../journal/branches.ts";
import { missingCommits } from "../journal/commits.ts";
import type { Decision, Enactment, JournalRecord } from "../journal/record.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Where Coherence itself is installed: its own checkout, or the package in an adopter. */
export const COHERENCE_ROOT = resolve(here, "..", "..");

/** The name an id carries before a kernel practice, as an adopter reads it. */
export const KERNEL_PREFIX = "coherence:";

export type PracticeState = "candidate" | "established";

export interface ModelPractice extends Practice {
  /** The component folder and the name: src/enforcement/witness a refutation; coherence: first for a kernel practice in an adopter. */
  id: string;
  component: string;
  /** The practice file, relative to the root it was read from. */
  file: string;
  /** Established once an enactment produced the evidence of every step that names it; a candidate before. */
  state: PracticeState;
  enactments: number;
}

/** The stem a spec and its practice file share: Enforcement for Enforcement.spec.md. */
export function stemOf(path: string): string {
  const name = basename(path);
  for (const suffix of [".spec.md", PRACTICE_SUFFIX]) if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  return name;
}

/** Whether the root is Coherence's own tree, read from its package name: there its practices are the project's own. */
export function isCoherenceTree(root: string): boolean {
  try {
    if (realpathSync(resolve(root)) === realpathSync(COHERENCE_ROOT)) return true;
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown };
    return pkg.name === "@posthog/coherence";
  } catch {
    return false;
  }
}

/** The enactments in a journal, oldest first. */
export function enactmentsIn(records: readonly JournalRecord[]): Enactment[] {
  return records.filter((r): r is Enactment => r.kind === "enactment");
}

/** Whether an enactment produced the evidence of every step that names what it leaves. */
export function witnessedWhole(enactment: Enactment): boolean {
  return enactment.steps.every((step, index) => {
    if (step.leaves === undefined) return true;
    const outcome = enactment.results[String(index + 1)];
    return outcome?.result === "done" && outcome.evidence !== undefined && outcome.evidence.trim() !== "";
  });
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** A practice as the model holds it, with its state read from the enactments. */
export function modelPractice(practice: Practice, id: string, component: string, file: string, enactments: readonly Enactment[]): ModelPractice {
  const mine = enactments.filter((e) => e.practice === id);
  return { ...practice, id, component, file, state: mine.some(witnessedWhole) ? "established" : "candidate", enactments: mine.length };
}

/** The kernel practices, read from where Coherence is installed: those whose reach is kernel. */
export function kernelPractices(enactments: readonly Enactment[] = []): ModelPractice[] {
  const src = join(COHERENCE_ROOT, "src");
  if (!existsSync(src)) return [];
  const out: ModelPractice[] = [];
  for (const folder of readdirSync(src, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const name of readdirSync(join(src, folder.name))) {
      if (!name.endsWith(PRACTICE_SUFFIX)) continue;
      const rel = `src/${folder.name}/${name}`;
      const parsed = parsePractices(readFileSync(join(COHERENCE_ROOT, rel), "utf8"), rel);
      for (const practice of parsed.practices) {
        if (practice.reach !== "kernel") continue;
        out.push(modelPractice(practice, `${KERNEL_PREFIX}src/${folder.name}/${practice.name}`, `src/${folder.name}`, rel, enactments));
      }
    }
  }
  return out;
}

export interface PracticeChecks {
  root: string;
  practices: readonly ModelPractice[];
  /** Every invariant name by component folder, for invariants: lines to resolve. */
  invariantsByFolder: ReadonlyMap<string, ReadonlySet<string>>;
  /** Whether the root is Coherence's own tree, where every practice declares its reach and nowhere else may. */
  coherenceTree: boolean;
  records: readonly JournalRecord[];
}

/**
 * The model-level problems of a project's practices: a citation found nowhere,
 * an invariant no spec declares, a reach missing in Coherence's tree or written outside it,
 * and a step or pitfall gone from an enacted practice with no decision amending it (floorGaps).
 */
export function practiceProblems(checks: PracticeChecks): Problem[] {
  const { root, practices, invariantsByFolder, coherenceTree, records } = checks;
  const problems: Problem[] = [];
  if (practices.length === 0) return problems;

  // Citations: a record id must be in the journal or the work store (here or on another branch), a commit in git.
  const cited = practices.flatMap((p) => [...p.pitfalls.flatMap((pf) => pf.cites.map((c) => ({ p, c, line: pf.line }))), ...p.learned.map((c) => ({ p, c, line: p.lines.learned ?? p.line }))]);
  const isRecord = (c: string): boolean => new RegExp(`^${RECORD_ID.source}$`).test(c);
  const known = new Set<string>([...records.map((r) => r.id), ...loadWork(root).records.map((r) => r.id)]);
  const unknownIds = [...new Set(cited.filter(({ c }) => isRecord(c) && !known.has(c)).map(({ c }) => c))];
  const elsewhere = unknownIds.length === 0 ? new Map() : recordsOnOtherBranches(root, unknownIds);
  const commits = [...new Set(cited.filter(({ c }) => !isRecord(c)).map(({ c }) => c))];
  const absent = missingCommits(root, commits);
  for (const { p, c, line } of cited) {
    if (isRecord(c)) {
      if (!known.has(c) && !elsewhere.has(c)) problems.push({ file: p.file, line, message: `practice ${p.name} cites ${c}, which no journal or work record has, here or on another branch` });
    } else if (absent !== undefined && absent.has(c)) {
      problems.push({ file: p.file, line, message: `practice ${p.name} cites ${c}, which is no commit in this repository` });
    }
  }

  for (const p of practices) {
    // Never examined and examined are different facts (d-8ed21083): in Coherence's tree every practice says how far it goes.
    if (coherenceTree && p.lines.reach === undefined) {
      problems.push({ file: p.file, line: p.line, message: `practice ${p.name} declares no reach: in Coherence's own tree every practice says how far it goes, reach: kernel (every adopter receives it) or reach: internal (it never leaves this tree)` });
    }
    if (!coherenceTree && p.lines.reach !== undefined) {
      problems.push({ file: p.file, line: p.lines.reach, message: `practice ${p.name}: reach: is for Coherence's own practices; a project's practices are its own, and reach nowhere else` });
    }
    for (const name of p.invariants) {
      const slash = name.lastIndexOf("/");
      const folder = slash === -1 ? p.component : name.slice(0, slash);
      const invariant = slash === -1 ? name : name.slice(slash + 1);
      if (invariantsByFolder.get(folder)?.has(invariant)) continue;
      problems.push({ file: p.file, line: p.lines.invariants ?? p.line, message: `practice ${p.name} names invariant ${name}, which ${slash === -1 ? "its sister spec" : `the spec at ${folder}`} does not declare` });
    }
  }

  // A trigger that names no file of this project can never fire, and would never say so.
  for (const dead of deadTriggers(root, practices)) problems.push({ file: dead.practice.file, line: dead.line, message: deadTriggerText(dead) });

  // The floor: what any enactment carried out may leave the practice only with a decision that amends it.
  for (const p of practices) {
    for (const gap of floorGaps(p, records)) {
      problems.push({
        file: p.file,
        line: p.line,
        message: `practice ${p.name}: ${gap.what} was enacted in ${gap.taughtIn.id} and is gone; a practice keeps what it taught unless a decision says why: ${amendCommand(p.id, gap.taughtIn.id)}`,
      });
    }
  }
  return problems;
}

/** A step or pitfall an enactment taught that has left the practice with no decision amending it. */
export interface FloorGap {
  /** step "<text>" or pitfall "<text>". */
  what: string;
  /** The latest enactment that still carried it out. */
  taughtIn: Enactment;
}

/** The decide command that records an amendment of a practice, citing the enactment that taught what left it. */
export function amendCommand(id: string, enactment: string): string {
  return `decide "amend ${id}: <what changed>" --because "<why>" --cite ${enactment}`;
}

function namesPractice(chose: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w/-])${escaped}($|[^\\w/-])`).test(chose);
}

/**
 * The floor of one practice: every step and pitfall that any of its
 * enactments carried out, of any version, and the practice no longer holds,
 * unless a decision recorded at or after the latest enactment that still
 * carried it out cites an enactment of the practice and names the practice's
 * id in what it chose. Re-enacting the edited practice never clears it.
 *
 * A kernel practice in an adopter (its id led by coherence:) has no floor
 * there: its text is Coherence's, it changes with a Coherence release, and
 * the decision that amends it is recorded in Coherence's own tree, where the
 * floor holds it. An adopter is never asked to decide for a change it did not
 * make; its enactments of an earlier version stand as its history.
 */
export function floorGaps(practice: Pick<Practice, "steps" | "pitfalls"> & { id: string }, records: readonly JournalRecord[]): FloorGap[] {
  if (practice.id.startsWith(KERNEL_PREFIX)) return [];
  const mine = enactmentsIn(records).filter((e) => e.practice === practice.id);
  if (mine.length === 0) return [];
  const steps = new Set(practice.steps.map((s) => normalize(s.text)));
  const pitfalls = new Set(practice.pitfalls.map((pf) => normalize(pf.text)));
  // Each text gone, keyed by kind and text, with the latest enactment that carried it out (enactments are oldest first).
  const gone = new Map<string, FloorGap>();
  for (const e of mine) {
    for (const s of e.steps) if (!steps.has(normalize(s.text))) gone.set(`step ${normalize(s.text)}`, { what: `step "${s.text}"`, taughtIn: e });
    for (const pf of e.pitfalls) if (!pitfalls.has(normalize(pf))) gone.set(`pitfall ${normalize(pf)}`, { what: `pitfall "${pf}"`, taughtIn: e });
  }
  if (gone.size === 0) return [];
  const ids = new Set(mine.map((e) => e.id));
  const amendments = records.filter((r): r is Decision => r.kind === "decision" && (r.cites ?? []).some((id) => ids.has(id)) && namesPractice(r.chose, practice.id));
  return [...gone.values()].filter((gap) => !amendments.some((d) => d.at >= gap.taughtIn.at));
}

/** The journal's records for the checks, or none when the journal cannot be read: the spec check never fails on the journal. */
export function journalRecords(root: string): JournalRecord[] {
  try {
    return loadJournal(root).records;
  } catch {
    return [];
  }
}

/** An edit trigger of a project's own practice that matches no file of its project, so the practice can never fire on it. */
export interface DeadTrigger {
  practice: ModelPractice;
  glob: string;
  line: number;
  /** The same path relative to this project's folder, when it was written relative to the repository top and matches there. */
  suggestion?: string;
  /** Files of the repository outside this project that the glob does match: a practice here never sees them. */
  outside?: string[];
}

/**
 * Every edit trigger of the project's own practices (a kernel practice's are
 * Coherence's) that matches no project file. A when: line's paths are
 * relative to the project's folder, so a trigger written relative to the
 * repository top, as a whole-repository adoption wrote them, names nothing
 * once the project is a folder below the top: it is reported with the path
 * that folder makes of it, or with the files outside the project it names.
 * The project's files are listed once, and only when an edit trigger exists.
 */
export function deadTriggers(root: string, practices: readonly ModelPractice[]): DeadTrigger[] {
  const seen = new Set<string>();
  const edits = practices
    .filter((p) => !p.id.startsWith(KERNEL_PREFIX))
    .flatMap((p) => p.triggers.flatMap((t) => (t.kind === "edit" ? [{ p, glob: t.glob }] : [])))
    .filter(({ p, glob }) => !seen.has(`${p.id}\n${glob}`) && seen.add(`${p.id}\n${glob}`) !== undefined);
  if (edits.length === 0) return [];
  // The spec model loads several times in one hook: a literal path costs one git call for all of them, a pattern only the folder before its first wildcard.
  const literal = (glob: string): boolean => !/[*?]/.test(glob);
  const under = new Map<string, string[]>();
  const filesFor = (glob: string): string[] => {
    const folder = literalFolder(glob);
    let files = under.get(folder);
    if (files === undefined) under.set(folder, (files = projectFilesUnder(root, folder)));
    return files;
  };
  const asked = new Set(edits.filter(({ glob }) => literal(glob)).map(({ glob }) => glob));
  const kept = keepProjectFiles(root, [...asked]);
  const matches = (glob: string): boolean => {
    if (!literal(glob)) return filesFor(glob).some((f) => globMatches(glob, f));
    return asked.has(glob) ? kept.has(glob) : keepProjectFiles(root, [glob]).size === 1;
  };
  const nested = nestedFolder(root);
  const out: DeadTrigger[] = [];
  for (const { p, glob } of edits) {
    if (matches(glob)) continue;
    const dead: DeadTrigger = { practice: p, glob, line: p.lines.when ?? p.line };
    if (nested !== undefined && glob.startsWith(`${nested}/`)) {
      const rest = glob.slice(nested.length + 1);
      if (matches(rest)) dead.suggestion = rest;
    }
    if (dead.suggestion === undefined && nested !== undefined) {
      // The repository asked as narrowly as the project: never its whole listing, at every one of a hook's model loads.
      const top = repositoryTop(root);
      const candidates = top === undefined ? [] : literal(glob) ? [...keepProjectFiles(top, [glob])] : projectFilesUnder(top, literalFolder(glob));
      const hits = candidates.filter((f) => globMatches(glob, f) && f !== nested && !f.startsWith(`${nested}/`));
      if (hits.length > 0) dead.outside = hits.slice(0, 3);
    }
    out.push(dead);
  }
  return out;
}

/** The folders of a trigger's path before its first wildcard: all a listing must cover to answer it. */
function literalFolder(glob: string): string {
  const folders = glob.split("/").slice(0, -1);
  const wild = folders.findIndex((part) => /[*?]/.test(part));
  return (wild === -1 ? folders : folders.slice(0, wild)).join("/");
}

export function deadTriggerText(dead: DeadTrigger): string {
  const head = `practice ${dead.practice.name}: its trigger edit ${dead.glob} matches no file in this project, so the practice never fires on it; paths in a when: line are relative to the project's folder`;
  if (dead.suggestion !== undefined) return `${head}: write edit ${dead.suggestion}`;
  if (dead.outside !== undefined) return `${head}, and it names ${dead.outside.join(", ")}, outside this project, which a practice here never sees: keep that trigger in a practice of the project that holds those files`;
  return `${head}; correct the path, or remove the trigger`;
}
