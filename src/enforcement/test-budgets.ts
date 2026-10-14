/**
 * The unit suite's cost budgets, kept by the leak guard (leak-guard.ts) in
 * every test file's process, so a test that pays a cost multiplied by the
 * tests fails when it is written, not days later as a slower CI:
 *
 * - the spawn budget: a test file may launch Coherence's own command line (a
 *   node process whose arguments name this repository's src/cli.ts or
 *   dist/cli.js) and wait on it at most SPAWN_BUDGET times; each launch pays Node's start
 *   and Coherence's load, about a second. cli() (lifecycle/cli-fixture.ts)
 *   runs the same command in the file's own process. A `*.e2e.ts` file is
 *   where spawned end-to-end tests live, and has no spawn budget.
 * - the time ceiling: a unit test that runs longer than TEST_CEILING_SECONDS
 *   fails, unless it declares a budget of its own that cites a decision:
 *   budget(t, <seconds>, "<d-id>"), first in its body. The budget is a
 *   ceiling too, never a skip: the test still fails past it, and a budget
 *   without a decision the journal holds fails the test.
 * - the whole tree: no unit test reads Coherence's own tree (a git listing,
 *   search or comparison, or a recursive tool, run in this repository), whose
 *   cost grows with every merge; that work belongs to the bench job.
 */

import { statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { projectSized, type WatchedSpawn } from "../lifecycle/work-meter.ts";

/** This repository: the checkout whose command line the spawn budget counts and whose tree no unit test reads. */
export const REPOSITORY = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The launches of Coherence's own command line one test file may make. Three leave room for the odd spawned check; the fourth is a pattern. */
export const SPAWN_BUDGET = 3;

/**
 * The longest one unit test may run, in seconds, unless it declares a budget
 * of its own citing a decision. Picked from the suite's own times once its
 * commands ran in-process: on a 14-core machine under a load average near 9,
 * every test without a budget ran in 4.1 s or less, and CI's runners take up
 * to about 1.5 times as long for the same test; 8 s holds both with room, so
 * noise does not fail a test and a test that starts paying per call does.
 */
export const TEST_CEILING_SECONDS = 8;

/**
 * The ceiling this process keeps: TEST_CEILING_SECONDS, or lower where
 * COHERENCE_TEST_CEILING_SECONDS names a lower one (the budgets' own tests
 * do, to prove the ceiling without waiting it out); never higher.
 */
export function testCeiling(env: NodeJS.ProcessEnv = process.env): number {
  const given = Number(env["COHERENCE_TEST_CEILING_SECONDS"]);
  return Number.isFinite(given) && given > 0 ? Math.min(given, TEST_CEILING_SECONDS) : TEST_CEILING_SECONDS;
}

/** The most a declared budget may be: a budget is a ceiling, never a way to switch the ceiling off. */
export const LONGEST_BUDGET_SECONDS = 120;

/** The command lines a launch of this repository's CLI names. */
const OWN_CLIS = [join(REPOSITORY, "src", "cli.ts"), join(REPOSITORY, "dist", "cli.js")];

const SHELL = /^(sh|bash|zsh|dash)$/;

/**
 * Whether a spawn launches this repository's own command line and waits on
 * it: node with its cli.ts or cli.js, directly or through a shell line naming
 * one. A detached launch (the warm server, a hook's background refresh) is
 * work the code under test starts and lets go by design, never a test paying
 * the load once per call, so it is not counted.
 */
export function launchesOwnCli(spawn: WatchedSpawn, cwd = process.cwd()): boolean {
  if (spawn.detached) return false;
  const program = basename(spawn.file);
  const from = spawn.cwd === undefined ? cwd : resolve(cwd, spawn.cwd);
  if (spawn.file === process.execPath || /^node(\.exe)?$/.test(program)) {
    return spawn.args.some((arg) => !arg.startsWith("-") && OWN_CLIS.includes(resolve(from, arg)));
  }
  // exec's one string, or sh -c "<line>": a line that names the CLI by its full path launches it.
  const lines = spawn.args.length === 0 ? [spawn.file] : SHELL.test(program) ? spawn.args : [];
  return lines.some((line) => OWN_CLIS.some((cli) => line.includes(cli)));
}

/** Whether a spawn reads this repository's whole tree: a git listing, search or comparison, or a recursive tool, run inside it. */
export function readsOwnTree(spawn: WatchedSpawn, cwd = process.cwd()): boolean {
  const from = spawn.cwd === undefined ? cwd : resolve(cwd, spawn.cwd);
  const rel = relative(REPOSITORY, from);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("node_modules")) return false;
  // Through a shell the line cannot be read for what it runs; only what it names directly is judged.
  if (SHELL.test(basename(spawn.file))) return false;
  if (!projectSized([spawn.file, ...spawn.args].join(" "))) return false;
  // A release's tree is fixed: its listing costs the same at every merge, and what grows is the count of releases.
  if (spawn.args.includes("ls-tree") && spawn.args.some((arg) => /^v\d+\.\d+\.\d+$/.test(arg))) return false;
  // A git question about named files (ls-files -- docs/lexicon.json) reads those files, not the tree.
  const at = spawn.args.indexOf("--");
  const named = at === -1 ? [] : spawn.args.slice(at + 1);
  return named.length === 0 || !named.every((path) => isFile(resolve(from, path)));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** One launch or tree read, with the test that made it. */
export interface Charged {
  test: string;
  line: string;
}

const CLI_INSTEAD = `Run the command in the file's own process instead, which pays the load once per file:
    import { cli } from "<src>/lifecycle/cli-fixture.ts";
    const { status, stdout, stderr } = await cli(["spec", "--check"], { cwd: root, env, stdin });
  A spawned end-to-end test of a command family belongs in a *.e2e.ts file, which has no spawn budget.`;

/** What a test file over its spawn budget prints: the count, the file, each test's launches, and cli() to use instead. */
export function describeSpawnBudget(file: string, launches: readonly Charged[]): string {
  const byTest = new Map<string, number>();
  for (const launch of launches) byTest.set(launch.test, (byTest.get(launch.test) ?? 0) + 1);
  const lines = [`spawn budget: ${file} launched Coherence's command line ${launches.length} times; a test file may launch it ${SPAWN_BUDGET} (src/enforcement/test-budgets.ts). Each launch pays Node's start and Coherence's load, about a second.`];
  for (const [test, count] of byTest) lines.push(`  ${count} in "${test}"`);
  lines.push(`  first: ${launches[0]?.line ?? ""}`);
  lines.push(`  ${CLI_INSTEAD.replaceAll("<src>", relative(file === "" ? REPOSITORY : resolve(file, ".."), join(REPOSITORY, "src")) || ".")}`);
  return `${lines.join("\n")}\n`;
}

/** The reads a report names one by one; the rest are counted. */
const SHOWN = 8;

/** What a test file that read Coherence's own tree prints: each read, by test. */
export function describeTreeReads(file: string, reads: readonly Charged[]): string {
  const lines = [`whole tree: ${file} read Coherence's own tree ${reads.length} time(s) (src/enforcement/test-budgets.ts). That cost grows with every merge; a unit test reads a fixture, and a reading over Coherence's own tree belongs in the bench job (bench/, .github/workflows/ci.yml).`];
  for (const read of reads.slice(0, SHOWN)) lines.push(`  "${read.test}": ${read.line}`);
  if (reads.length > SHOWN) lines.push(`  and ${reads.length - SHOWN} more`);
  return `${lines.join("\n")}\n`;
}

/** A test's own budget: the seconds it may run, and the decision that allows them. */
export interface DeclaredBudget {
  budget: number;
  because: string;
}

/** The budgets the tests of this process declared, by each test's full name. */
const declared = new Map<string, DeclaredBudget>();

/**
 * Declare that this test may run `seconds`, in place of the unit suite's
 * ceiling, because of the decision `because` ("d-xxxxxxxx", as coherence
 * decide recorded it). Call it first in the test's body:
 *
 *   test("...", async (t) => {
 *     budget(t, 30, "d-1234abcd");
 *     ...
 *   });
 *
 * The budget is a ceiling too, never a skip: the test still fails past it,
 * a malformed one throws here, and one that cites no decision the journal
 * holds fails the test.
 */
export function budget(t: { fullName: string }, seconds: number, because: string): void {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > LONGEST_BUDGET_SECONDS) {
    throw new Error(`time budget: a test's budget is a number of seconds above 0 and at most ${LONGEST_BUDGET_SECONDS}, not ${String(seconds)}`);
  }
  if (!/^d-[0-9a-f]{8}$/.test(because)) {
    throw new Error(`time budget: a test's budget cites the decision that allows it as "d-xxxxxxxx" (record one with coherence decide), not ${JSON.stringify(because)}`);
  }
  declared.set(t.fullName, { budget: seconds, because });
}

/** The budget the test of this full name declared, if any. */
export function declaredBudget(fullName: string): DeclaredBudget | undefined {
  return declared.get(fullName);
}

/** Whether the journal of this repository holds a decision with this id. */
export async function decisionHeld(id: string): Promise<boolean> {
  const { loadJournal } = await import("../journal/store.ts");
  return loadJournal(REPOSITORY).records.some((record) => record.kind === "decision" && record.id === id);
}

/** What a test over its ceiling fails with. */
export function overCeiling(name: string, seconds: number, ceiling: number, declared: DeclaredBudget | undefined): string {
  const limit = declared === undefined ? `the unit suite's ceiling of ${ceiling} s (src/enforcement/test-budgets.ts)` : `its declared budget of ${declared.budget} s (${declared.because})`;
  return (
    `time budget: "${name}" took ${seconds.toFixed(1)} s, over ${limit}. A unit test pays for its own work: run commands with cli() from src/lifecycle/cli-fixture.ts rather than spawning node src/cli.ts, shrink the fixture, or move the test to the bench job. ` +
    `A test that must take longer says so and why: budget(t, <seconds>, "<decision id>") from src/enforcement/test-budgets.ts, first in its body, citing a decision recorded with coherence decide.`
  );
}
