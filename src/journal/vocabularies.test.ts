import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CAUGHT as TELEMETRY_CAUGHT } from "../lifecycle/telemetry.ts";
import { RECORD_ID } from "../spec/practice.ts";
import { JOURNAL_USAGE } from "./cli.ts";
import { CAUGHT, KIND_NAMES, KINDS, MOVE_STATES, STEP_RESULTS, WORK_KINDS, WORK_STATES, alternation, recordId, spoken } from "./record.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A list as prose enumerates it, parentheticals aside: "a, b (the bee) or c" is a, b, c. */
function enumerated(text: string): string[] {
  return text
    .replace(/\s*\([^)]*\)/g, "")
    .split(/,\s*(?:or\s+|and\s+)?|\s+(?:or|and)\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

interface Vocabulary {
  name: string;
  values: readonly string[];
  /** Where the list is written out, by file (relative to the repository, or "help" for the verbs' usage), and the pattern whose first group writes it. */
  written: { where: string; pattern: RegExp; prose?: true; at_least: number }[];
}

const VOCABULARIES: Vocabulary[] = [
  {
    name: "what caught a defect",
    values: CAUGHT,
    written: [
      { where: "help", pattern: /--caught <([^>]*\|[^>]*)>/g, at_least: 2 },
      { where: "docs/journal.md", pattern: /--caught <([^>]*\|[^>]*)>/g, at_least: 1 },
      { where: "docs/journal.md", pattern: /^- `caught`: ([^.]+)\./gm, prose: true, at_least: 1 },
      { where: "src/journal/Journal.spec.md", pattern: /\bcaught is ([^;]+);/g, prose: true, at_least: 1 },
      { where: "docs/lexicon.json", pattern: /"caught": "What caught a defect: ([^."]+)\./g, prose: true, at_least: 1 },
    ],
  },
  {
    name: "an experiment step's result",
    values: STEP_RESULTS,
    written: [
      { where: "help", pattern: /--result <stepId>=<([^>]+)>/g, at_least: 1 },
      { where: "docs/journal.md", pattern: /--result <stepId>=<([^>]+)>/g, at_least: 1 },
    ],
  },
  {
    name: "the states work move takes",
    values: MOVE_STATES,
    written: [
      { where: "help", pattern: /work move <id> <([^>]+)>/g, at_least: 1 },
      { where: "docs/journal.md", pattern: /work move <id> <([^>]+)>/g, at_least: 1 },
    ],
  },
  {
    name: "a work order's states",
    values: WORK_STATES,
    written: [{ where: "docs/lexicon.json", pattern: /its states are ([^;.]+)[;.]/g, prose: true, at_least: 1 }],
  },
  {
    name: "the journal's kinds",
    values: KIND_NAMES,
    written: [{ where: "help", pattern: /--kind <([^>]+)>/g, at_least: 1 }],
  },
];

/** Every source module Coherence runs, tests and fixtures aside, and the CI scripts. */
function sources(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "fonts") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, into);
    else if (/\.(ts|mjs)$/.test(entry.name) && !/\.(test|e2e)\.ts$/.test(entry.name) && !/fixture/.test(entry.name)) into.push(path);
  }
  return into;
}

/** The spellings of a list copied by hand into code: a quoted array, a union of literal types, or an alternation. */
function copiesOf(values: readonly string[], text: string): string[] {
  const escaped = values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const quoted = (separator: string): string => escaped.map((v) => `["'\`]${v}["'\`]`).join(`\\s*${separator}\\s*`);
  const bare = escaped.join("\\|");
  return [...text.matchAll(new RegExp(`${quoted(",")}|${quoted("\\|")}|(?<![\\w|])${bare}(?![\\w|])`, "g"))].map((m) => m[0]);
}

test("every closed list the journal verbs take is read from the record model, and every help line, doc and definition that enumerates one names exactly its members", () => {
  const texts = new Map<string, string>([["help", JOURNAL_USAGE]]);
  const read = (where: string): string => texts.get(where) ?? readFileSync(join(REPO, where), "utf8");
  for (const vocabulary of VOCABULARIES) {
    for (const place of vocabulary.written) {
      const found = [...read(place.where).matchAll(place.pattern)].map((m) => m[1]!);
      assert.ok(found.length >= place.at_least, `${place.where} no longer writes ${vocabulary.name} where ${place.pattern} looks; update the pattern with the text`);
      for (const written of found) {
        const members = place.prose === true ? enumerated(written) : written.split("|");
        assert.deepEqual(members, [...vocabulary.values], `${place.where} lists ${vocabulary.name} as ${written}, the record model as ${alternation(vocabulary.values)}`);
      }
    }
  }

  // The verbs refuse in the same words their lists give.
  assert.equal(spoken(STEP_RESULTS), "pass, fail, or unknown");

  // Fleet telemetry sends what caught a defect from the journal's list, and unknown for anything else.
  assert.deepEqual([...TELEMETRY_CAUGHT], [...CAUGHT, "unknown"]);

  // The id pattern practices cite by takes every prefix the minter mints, and no other.
  const kinds = [...Object.keys(KINDS), ...Object.keys(WORK_KINDS)] as (keyof typeof KINDS | keyof typeof WORK_KINDS)[];
  for (const kind of kinds) {
    const id = recordId(kind, "s", "2026-10-12T00:00:00.000Z", kind);
    assert.deepEqual([...`cites ${id}.`.matchAll(RECORD_ID)].map((m) => m[0]), [id], `a ${kind} id (${id}) is a citation`);
  }
  assert.deepEqual([...`zz-0123abcd`.matchAll(RECORD_ID)], [], "a prefix no kind mints is no citation");

  // No source module writes one of these lists out again, as an array or an alternation.
  const declared = new Set(["src/journal/record.ts", "src/journal/kinds.ts"]);
  const lists = [...VOCABULARIES.map((v) => v.values), [...Object.values(KINDS), ...Object.values(WORK_KINDS)]];
  for (const file of [...sources(join(REPO, "src")), ...sources(join(REPO, ".github"))]) {
    const at = relative(REPO, file);
    if (declared.has(at)) continue;
    const code = readFileSync(file, "utf8");
    for (const values of lists) assert.deepEqual(copiesOf(values, code), [], `${at} writes ${alternation(values)} out by hand; read it from the record model`);
  }
});
