/**
 * The practice grammar: a component's recorded methods, in the practice file
 * paired with its spec (d-861e8319). The file is a bare bullet list, one
 * practice per bullet, in the spec's bullet grammar:
 *
 *   - <name>: <sentence>
 *     when: command <words> | edit <glob> [adding <text>] | explicit
 *       (a command word with * or ? is a glob over one word: command resolved df-*)
 *     step: <what to do>
 *       leaves: <the evidence the step leaves>       optional; belongs to the step above it, at any indentation
 *     pitfall: <a way this practice has failed> (<record id or commit>)
 *     learned: <record id or commit>, ...
 *     invariants: <invariant name>, ...                optional; names in the sister spec
 *     reach: kernel | internal                         Coherence's own tree only, and required there: kernel ships to every adopter, internal never leaves
 *     because: <why the practice exists>
 *
 * A practice rests on evidence: a pitfall cites the record or commit that
 * witnessed it, and the practice as a whole cites at least one. Steps are
 * numbered from one in the order written. The version is a fingerprint of
 * the triggers, steps and pitfalls, so an enactment binds to the exact text
 * it carried out. The parser reports problems and never throws on content;
 * pairing, citations and the integrity of an enacted version are checked by
 * the model, which knows the specs and the journal.
 */

import { createHash } from "node:crypto";
import { KINDS, WORK_KINDS } from "../journal/kinds.ts";

export const PRACTICE_SUFFIX = ".practice.md";

/** The keys a practice bullet may carry. */
export const PRACTICE_KEYS = ["when", "step", "leaves", "pitfall", "learned", "invariants", "reach", "because"] as const;
export type PracticeKey = (typeof PRACTICE_KEYS)[number];

/**
 * How far one of Coherence's own practices goes: kernel ships to every adopter
 * beside the project's own practices; internal never leaves Coherence's tree.
 * An enum, not a yes or no, so a later reach is one more value.
 */
export const REACHES = ["kernel", "internal"] as const;
export type Reach = (typeof REACHES)[number];

export type Trigger =
  | { kind: "command"; words: string }
  | { kind: "edit"; glob: string; adding: string | undefined }
  | { kind: "explicit" };

export interface PracticeStep {
  /** The step's number, from one. */
  n: number;
  text: string;
  /** The evidence the step leaves, when it names one: an auditable step. */
  leaves: string | undefined;
  line: number;
}

export interface Pitfall {
  text: string;
  /** The record ids and commits the pitfall cites. */
  cites: string[];
  line: number;
}

export interface Practice {
  name: string;
  sentence: string;
  line: number;
  triggers: Trigger[];
  steps: PracticeStep[];
  pitfalls: Pitfall[];
  learned: string[];
  invariants: string[];
  /** Declared in Coherence's own tree, where every practice says how far it goes; undefined when no reach: line was written. */
  reach: Reach | undefined;
  because: string | undefined;
  /** Eight hex digits over the triggers, steps and pitfalls. */
  version: string;
  /** The line of each key as written, for problems that point at one. */
  lines: Partial<Record<PracticeKey, number>>;
}

export interface PracticeProblem {
  file: string;
  line: number;
  message: string;
}

export interface ParsedPractices {
  file: string;
  practices: Practice[];
  problems: PracticeProblem[];
}

/** A journal or work record id: a prefix the minter's tables declare (journal/kinds.ts) and eight hex digits. */
export const RECORD_ID = new RegExp(`\\b(?:${[...Object.values(KINDS), ...Object.values(WORK_KINDS)].join("|")})-[0-9a-f]{8}\\b`, "g");
/** A commit, abbreviated or whole: seven to forty hex digits standing alone. */
const COMMIT = /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/g;

/** The record ids and commits a text cites, in order, each once. */
export function citationsIn(text: string): string[] {
  const ids = [...text.matchAll(RECORD_ID)].map((m) => m[0]);
  const stripped = text.replace(RECORD_ID, " ");
  // A commit is only a citation inside a parenthetical or a learned: list, never a bare number in prose.
  const commits = [...stripped.matchAll(COMMIT)].map((m) => m[0]).filter((c) => /[a-f]/.test(c));
  return [...new Set([...ids, ...commits])];
}

const PRACTICE_SHAPE = "a practice is one bullet: - <name>: <sentence>, with indented when:, step:, pitfall:, learned:, because: lines";

function parseTriggers(value: string): { triggers: Trigger[]; problem: string | undefined } {
  const triggers: Trigger[] = [];
  for (const raw of value.split("|").map((part) => part.trim()).filter((part) => part !== "")) {
    if (raw === "explicit") {
      triggers.push({ kind: "explicit" });
      continue;
    }
    const command = /^command\s+(.+)$/.exec(raw);
    if (command !== null) {
      triggers.push({ kind: "command", words: command[1]!.trim() });
      continue;
    }
    const edit = /^edit\s+(\S+)(?:\s+adding\s+(.+))?$/.exec(raw);
    if (edit !== null) {
      triggers.push({ kind: "edit", glob: edit[1]!, adding: edit[2]?.trim() });
      continue;
    }
    return { triggers, problem: `"${raw}" is not a trigger; when: takes command <words>, edit <glob> [adding <text>], or explicit, separated by |` };
  }
  if (triggers.length === 0) return { triggers, problem: "when: names no trigger; write explicit for a practice no tool use fires" };
  return { triggers, problem: undefined };
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** The version: the triggers, steps (with what each leaves) and pitfalls, normalized and hashed. */
export function practiceVersion(practice: Pick<Practice, "triggers" | "steps" | "pitfalls">): string {
  const parts = [
    ...practice.triggers.map((t) => `when ${t.kind === "command" ? `command ${t.words}` : t.kind === "edit" ? `edit ${t.glob}${t.adding ? ` adding ${t.adding}` : ""}` : "explicit"}`),
    ...practice.steps.map((s) => `step ${normalize(s.text)}${s.leaves ? ` leaves ${normalize(s.leaves)}` : ""}`),
    ...practice.pitfalls.map((p) => `pitfall ${normalize(p.text)}`),
  ];
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 8);
}

export function parsePractices(text: string, file: string): ParsedPractices {
  const problems: PracticeProblem[] = [];
  const problem = (line: number, message: string): void => {
    problems.push({ file, line, message });
  };
  const practices: Practice[] = [];
  let current: Practice | undefined;
  let lastStep: PracticeStep | undefined;

  const close = (): void => {
    if (current === undefined) return;
    const p = current;
    if (p.lines.when === undefined) problem(p.line, `practice ${p.name} names no when: line; write explicit for a practice no tool use fires`);
    if (p.steps.length === 0) problem(p.line, `practice ${p.name} has no step: lines`);
    if (p.because === undefined) problem(p.line, `practice ${p.name} has no because: line`);
    if (p.learned.length === 0 && p.pitfalls.every((pf) => pf.cites.length === 0)) {
      problem(p.line, `practice ${p.name} cites no evidence: a practice is learned, so learned: or a pitfall names the records or commits it rests on`);
    }
    p.version = practiceVersion(p);
    practices.push(p);
    current = undefined;
    lastStep = undefined;
  };

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return;
    if (/^#/.test(raw)) {
      problem(line, "a practice file is a bare bullet list; its component's name and intent are in the sister spec");
      return;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(raw);
    if (bullet !== null) {
      close();
      const colon = bullet[1]!.indexOf(":");
      if (colon <= 0) {
        problem(line, PRACTICE_SHAPE);
        return;
      }
      const name = bullet[1]!.slice(0, colon).trim();
      const sentence = bullet[1]!.slice(colon + 1).trim();
      if (sentence === "") problem(line, `practice ${name} needs a sentence: what the practice keeps true`);
      if (practices.some((p) => p.name === name)) problem(line, `practice ${name} declared twice in this file`);
      current = { name, sentence, line, triggers: [], steps: [], pitfalls: [], learned: [], invariants: [], reach: undefined, because: undefined, version: "", lines: {} };
      return;
    }
    const field = /^(\s+)([a-z]+):\s*(.*)$/.exec(raw);
    if (current === undefined || field === null) {
      problem(line, `expected a practice bullet or an indented key line under one; ${PRACTICE_SHAPE}`);
      return;
    }
    const key = field[2]!;
    const value = field[3]!.trim();
    if (!(PRACTICE_KEYS as readonly string[]).includes(key)) {
      problem(line, `unknown key ${key}: on practice ${current.name}; a practice takes ${PRACTICE_KEYS.join(", ")}`);
      return;
    }
    if (value === "") {
      problem(line, `${key}: on practice ${current.name} is empty`);
      return;
    }
    const k = key as PracticeKey;
    const once = (): boolean => {
      if (current!.lines[k] !== undefined) {
        problem(line, `practice ${current!.name} gives ${k}: twice`);
        return false;
      }
      current!.lines[k] = line;
      return true;
    };
    switch (k) {
      case "when": {
        if (!once()) return;
        const { triggers, problem: wrong } = parseTriggers(value);
        current.triggers = triggers;
        if (wrong !== undefined) problem(line, `practice ${current.name}: ${wrong}`);
        return;
      }
      case "step": {
        current.lines.step ??= line;
        lastStep = { n: current.steps.length + 1, text: value, leaves: undefined, line };
        current.steps.push(lastStep);
        return;
      }
      case "leaves": {
        if (lastStep === undefined) {
          problem(line, `leaves: on practice ${current.name} comes before any step; it follows the step whose evidence it names, at any indentation`);
          return;
        }
        if (lastStep.leaves !== undefined) {
          problem(line, `step ${lastStep.n} of ${current.name} names what it leaves twice`);
          return;
        }
        lastStep.leaves = value;
        return;
      }
      case "pitfall": {
        current.lines.pitfall ??= line;
        const cites = citationsIn(value);
        if (cites.length === 0) problem(line, `a pitfall of ${current.name} cites no record or commit; name the one that witnessed it, in parentheses`);
        current.pitfalls.push({ text: value, cites, line });
        return;
      }
      case "learned": {
        if (!once()) return;
        const cites = citationsIn(value);
        if (cites.length === 0) problem(line, `learned: on ${current.name} names no record id or commit`);
        current.learned = cites;
        return;
      }
      case "invariants": {
        if (!once()) return;
        current.invariants = value.split(",").map((v) => v.trim()).filter((v) => v !== "");
        return;
      }
      case "reach": {
        if (!once()) return;
        if (!(REACHES as readonly string[]).includes(value)) problem(line, `reach: on ${current.name} is "${value}"; it takes one of ${REACHES.join(", ")} (kernel ships to every adopter, internal never leaves Coherence's tree)`);
        else current.reach = value as Reach;
        return;
      }
      case "because": {
        if (!once()) return;
        current.because = value;
        return;
      }
    }
  });
  close();
  return { file, practices, problems };
}

/* ----------------------------------------------------------- triggers */

/** A glob over project-relative paths: ** crosses folders, * and ? stay within one. */
export function globMatches(glob: string, path: string): boolean {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      // **/ matches zero or more whole folders; a trailing ** matches the rest.
      if (glob[i + 2] === "/") {
        pattern += "(?:.*/)?";
        i += 2;
      } else {
        pattern += ".*";
        i += 1;
      }
    } else if (ch === "*") pattern += "[^/]*";
    else if (ch === "?") pattern += "[^/]";
    else pattern += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`).test(path);
}

/** What a tool use offers a trigger: the command it runs, or the files it writes and the text it adds. */
export interface ToolUse {
  command: string | undefined;
  /** The command's simple commands as the shell reads them, when the caller read it so: a trigger then matches whole words of one command, never text inside a quoted argument or a heredoc's body. */
  commands?: readonly { words: readonly string[] }[];
  writes: string[];
  added: string;
}

/**
 * One word of a command trigger as a test of one word of the command: a
 * literal word is equal or not; a word with * or ? is a glob over that one
 * word, * any run of non-blank characters and ? one, so df-* matches df-1a2b
 * and never resolved df-1 as one quoted argument.
 */
function wordTest(word: string): (candidate: string) => boolean {
  if (!/[*?]/.test(word)) return (candidate) => candidate === word;
  const pattern = new RegExp(`^${[...word].map((ch) => (ch === "*" ? "\\S*" : ch === "?" ? "\\S" : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("")}$`);
  return (candidate) => pattern.test(candidate);
}

/** Whether the words appear in the command as whole words, in order and adjacent; a glob word matches one word of the text. */
export function commandMatches(words: string, command: string): boolean {
  const word = "[^\\s;&|()'\"]";
  const escaped = words
    .trim()
    .split(/\s+/)
    .map((w) => [...w].map((ch) => (ch === "*" ? `${word}*` : ch === "?" ? word : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join(""))
    .join("\\s+");
  return new RegExp(`(?:^|[\\s;&|(/'"])${escaped}(?=$|[\\s;&|)'"])`).test(command);
}

/**
 * Whether the trigger's words are adjacent words of one simple command, each
 * equal to its word or matching it as a one-word glob (resolved df-* is
 * resolved followed at once by an argument starting df-); the first may be a
 * program named by its path (./bin/turn-knob).
 */
export function commandWordsMatch(words: string, command: readonly string[]): boolean {
  const wanted = words.trim().split(/\s+/).map(wordTest);
  for (let i = 0; i + wanted.length <= command.length; i += 1) {
    const first = command[i]!;
    if (!wanted[0]!(first) && !wanted[0]!(first.slice(first.lastIndexOf("/") + 1))) continue;
    if (wanted.every((test, k) => k === 0 || test(command[i + k]!))) return true;
  }
  return false;
}

/** The first trigger of a practice this tool use fires, described, or undefined. */
export function firedBy(practice: Practice, use: ToolUse): string | undefined {
  for (const trigger of practice.triggers) {
    if (trigger.kind === "command" && use.command !== undefined) {
      const matched = use.commands === undefined ? commandMatches(trigger.words, use.command) : use.commands.some((c) => commandWordsMatch(trigger.words, c.words));
      if (matched) return `command ${trigger.words}`;
    }
    if (trigger.kind === "edit") {
      const file = use.writes.find((w) => globMatches(trigger.glob, w));
      if (file === undefined) continue;
      if (trigger.adding !== undefined && !use.added.includes(trigger.adding)) continue;
      return `edit ${file}${trigger.adding ? ` adding ${trigger.adding}` : ""}`;
    }
  }
  return undefined;
}

/** A trigger as the orient line writes it. */
export function triggerText(trigger: Trigger): string {
  if (trigger.kind === "command") return trigger.words;
  if (trigger.kind === "edit") return `edit ${trigger.glob}${trigger.adding ? ` adding ${trigger.adding}` : ""}`;
  return "explicit";
}

/** The practice whole, as delivered when its trigger fires: sentence, steps with what each leaves, then pitfalls. */
export function renderPractice(id: string, practice: Practice): string[] {
  const lines = [`Practice ${id} (version ${practice.version}): ${practice.sentence}`];
  for (const step of practice.steps) {
    lines.push(`  ${step.n}. ${step.text}`);
    if (step.leaves !== undefined) lines.push(`     leaves: ${step.leaves}`);
  }
  if (practice.pitfalls.length > 0) {
    lines.push("  Pitfalls, each one witnessed:");
    for (const pitfall of practice.pitfalls) lines.push(`  ! ${pitfall.text}`);
  }
  return lines;
}
