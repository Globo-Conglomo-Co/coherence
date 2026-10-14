import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BUDGET_FLAG_NAMES, BUDGET_FLAGS } from "../readings/scope/component-interfaces.ts";
import { flowPartialText } from "../readings/scope/structure-flow.ts";
import { HOOK_EVENTS, TOOL_HOOKS } from "./hook-events.ts";
import { HOSTS } from "./hosts.ts";
import { singular, singularForms } from "./inflection.ts";
import { DISPOSITIONS, singularForms as coverageSingulars } from "./lexicon-coverage.ts";
import { LEXICON_WORK_USAGE } from "./lexicon-cli.ts";
import { CHANGE_ACTIONS } from "./lexicon-maintain.ts";
import { LOCKFILES } from "./lockfiles.ts";
import { HOSTS as TELEMETRY_HOSTS, SUMMARY_EVENTS } from "./telemetry.ts";
import { packageManager } from "./version.ts";
import { cli } from "./cli-fixture.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every source module Coherence runs, tests and fixtures aside, the CI scripts and the benchmarks. */
function sources(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "fonts" || entry.name === "mirrors") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, into);
    else if (/\.(ts|mjs)$/.test(entry.name) && !/\.(test|e2e)\.ts$/.test(entry.name) && !/fixture/.test(entry.name)) into.push(path);
  }
  return into;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A list written out by hand in code: its members quoted and joined by commas or by a union's bars, or alternated bare. */
function copiesOf(values: readonly string[], text: string): string[] {
  const quoted = (separator: string): string => values.map((v) => `["'\`]${escape(v)}["'\`]`).join(`\\s*${separator}\\s*`);
  const bare = values.map(escape).join("\\|");
  return [...text.matchAll(new RegExp(`${quoted(",")}|${quoted("\\|")}|(?<![\\w|-])${bare}(?![\\w|-])`, "g"))].map((m) => m[0]);
}

/** A list as prose enumerates it, code ticks aside: "`a`, `b`, and `c`" is a, b, c. */
function enumerated(text: string): string[] {
  return text
    .replace(/`/g, "")
    .split(/,\s*(?:or\s+|and\s+)?|\s+(?:or|and)\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

test("every list the hooks, telemetry, ci, the update line and the lexicon verbs share is read from the one module that declares it, and its usage and docs name exactly its members", async () => {
  // Telemetry summarizes the events the hook answers, and the hosts it installs into.
  assert.deepEqual([...SUMMARY_EVENTS], [...HOOK_EVENTS]);
  assert.deepEqual([...TELEMETRY_HOSTS], [...HOSTS, "unknown"]);

  // The update line and ci install read each lockfile's manager from one table.
  const dir = mkdtempSync(join(tmpdir(), "coherence-lockfiles-"));
  try {
    for (const [file, manager] of LOCKFILES) {
      spawnSync("git", ["init", "-q", dir]);
      writeFileSync(join(dir, file), "");
      assert.equal(packageManager(dir), manager, `${file} names ${manager}`);
      rmSync(join(dir, file));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // The lexicon verbs' usage and docs name exactly the actions and dispositions the verbs take.
  const operations = readFileSync(join(REPO, "docs", "lexicon-operations.md"), "utf8");
  assert.ok(LEXICON_WORK_USAGE.includes(`lexicon propose ${CHANGE_ACTIONS.join("|")} `));
  assert.ok(LEXICON_WORK_USAGE.includes(`--disposition ${DISPOSITIONS.join("|")} `));
  assert.deepEqual(enumerated(/^Actions are ([^.]+)\./m.exec(operations)?.[1] ?? ""), [...CHANGE_ACTIONS], "docs/lexicon-operations.md lists the proposal actions");
  assert.deepEqual(enumerated(/^Dispositions are ([^.]+)\./m.exec(operations)?.[1] ?? ""), [...DISPOSITIONS], "docs/lexicon-operations.md lists the dispositions");

  // The check and coverage undo one set of plural rules.
  for (const word of ["entries", "classes", "boxes", "runs", "class", "bus"]) {
    assert.deepEqual(coverageSingulars(word), singularForms(word));
    assert.equal(singular(word), singularForms(word)[0] ?? word);
  }

  // Every command that takes the interface budget flags writes and parses them from one table.
  const help = (await cli(["help"])).stdout;
  const written = help.split("\n").filter((line) => line.includes(`--${BUDGET_FLAG_NAMES[0]}`));
  assert.ok(written.length >= 3, "scope, query structure and scaffold control take the budget flags");
  for (const line of written) assert.ok(line.includes(BUDGET_FLAGS), `usage writes the budget flags from the table: ${line}`);
  const partial = flowPartialText({ partial: { limit: "time", budget: "600 s", seconds: 600, unread: [] } } as never) ?? "";
  for (const flag of BUDGET_FLAG_NAMES) assert.ok(partial.includes(`--${flag}`), `the partial map's advice names --${flag}`);

  // No other module writes one of these lists, or a plural rule, out again.
  const declaredIn: [readonly string[], string][] = [
    [HOOK_EVENTS, "src/lifecycle/hook-events.ts"],
    [HOSTS, "src/lifecycle/hosts.ts"],
    [CHANGE_ACTIONS, "src/lifecycle/lexicon-maintain.ts"],
    [DISPOSITIONS, "src/lifecycle/lexicon-coverage.ts"],
    [BUDGET_FLAG_NAMES, "src/readings/scope/component-interfaces.ts"],
  ];
  const held = new Set(["src/lifecycle/statusline.ts"]); // imports nothing of Coherence's; its copy of the tool hooks is held equal by its own test
  for (const file of [...sources(join(REPO, "src")), ...sources(join(REPO, ".github")), ...sources(join(REPO, "bench"))]) {
    const at = relative(REPO, file);
    const code = readFileSync(file, "utf8");
    for (const [values, home] of declaredIn) if (at !== home) assert.deepEqual(copiesOf(values, code), [], `${at} writes ${values.join("|")} out by hand; import it from ${home}`);
    if (at !== "src/lifecycle/hook-events.ts" && !held.has(at)) assert.deepEqual(copiesOf([...TOOL_HOOKS], code), [], `${at} writes the tool hooks out by hand`);
    if (at !== "src/lifecycle/lockfiles.ts") for (const [lockfile] of LOCKFILES) assert.ok(!new RegExp(`["'\`]${escape(lockfile)}["'\`]`).test(code), `${at} names ${lockfile} by hand; read it from lockfiles.ts`);
    if (at !== "src/lifecycle/inflection.ts") assert.doesNotMatch(code, /\(\?:?ss\|sh\|ch\|x\|z\)es\$/, `${at} keeps a plural rule of its own; use inflection.ts`);
  }
});
