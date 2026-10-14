/**
 * The unit suite's cost budgets over real node:test runs of fixture files,
 * each run under the leak guard as npm test runs every file: the spawn
 * budget, the time ceiling with its declared budgets, and the whole-tree rule.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { loadJournal } from "../journal/store.ts";
import { REPOSITORY, SPAWN_BUDGET } from "./test-budgets.ts";

const GUARD = fileURLToPath(new URL("./leak-guard.ts", import.meta.url));
const BUDGETS = new URL("./test-budgets.ts", import.meta.url).href;
const CLI = join(REPOSITORY, "src", "cli.ts");
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** Run fixture test files, each in its own node:test run under the leak guard, as npm test runs a file; the runs go side by side. */
async function runFixtures(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): Promise<Map<string, { status: number | null; output: string }>> {
  const root = mkdtempSync(join(tmpdir(), "coherence-test-budgets-"));
  made.push(root);
  // The fixture's own runner: NODE_TEST_CONTEXT would make it think it runs inside this one.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete childEnv["NODE_TEST_CONTEXT"];
  const runs = Object.entries(files).map(([name, text]) => {
    writeFileSync(join(root, name), text, "utf8");
    return new Promise<[string, { status: number | null; output: string }]>((resolve) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", `--import=${GUARD}`, "--test", name], { cwd: root, env: childEnv, timeout: 60_000 });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.on("close", (status) => resolve([name, { status, output }]));
    });
  });
  return new Map(await Promise.all(runs));
}

/** A test file whose one test launches Coherence's command line `n` times, each launch as cheap as node gets: the CLI is named, never loaded. */
function launching(n: number, options = "{}"): string {
  return `import { test } from "node:test";
import { spawnSync } from "node:child_process";
test("launches the command line", () => {
  for (let i = 0; i < ${n}; i++) spawnSync(process.execPath, ["-e", "0", ${JSON.stringify(CLI)}], ${options});
});
`;
}

test("the spawn budget fails a test file that launches Coherence's command line more than its budget, naming the count, the file, each test's launches and cli(), and passes one at the budget, one whose launches run detached, and a *.e2e.ts file", { timeout: 120_000 }, async () => {
  const runs = await runFixtures({
    "over.test.mjs": launching(SPAWN_BUDGET + 1),
    "at.test.mjs": launching(SPAWN_BUDGET),
    "spawned.e2e.ts": launching(SPAWN_BUDGET + 2),
    "detached.test.mjs": launching(SPAWN_BUDGET + 2, "{ detached: true }"),
  });
  const over = runs.get("over.test.mjs")!;
  assert.notEqual(over.status, 0, over.output);
  assert.match(over.output, new RegExp(`spawn budget: \\S*over\\.test\\.mjs launched Coherence's command line ${SPAWN_BUDGET + 1} times; a test file may launch it ${SPAWN_BUDGET}`));
  assert.match(over.output, new RegExp(`${SPAWN_BUDGET + 1} in "launches the command line"`));
  assert.match(over.output, /import \{ cli \} from "\S*lifecycle\/cli-fixture\.ts"/);
  assert.match(over.output, /\*\.e2e\.ts file/);
  for (const name of ["at.test.mjs", "spawned.e2e.ts", "detached.test.mjs"]) {
    const run = runs.get(name)!;
    assert.equal(run.status, 0, `${name}: ${run.output}`);
    assert.doesNotMatch(run.output, /spawn budget:/);
  }
});

test("the time ceiling fails a test that runs past it, nested or called back, in its own file's name and place, and holds a test that declares a budget citing a decision to that budget; a budget citing no decision, or none at all, fails", { timeout: 120_000 }, async () => {
  const decision = loadJournal(REPOSITORY).records.find((record) => record.kind === "decision")?.id;
  assert.ok(decision !== undefined, "this repository's journal holds a decision to cite");
  const sleep = (ms: number) => `await new Promise((resolve) => setTimeout(resolve, ${ms}))`;
  const head = `import { describe, it, test } from "node:test";\nimport { budget } from ${JSON.stringify(BUDGETS)};\n`;
  const runs = await runFixtures(
    {
      "slow.test.mjs": `${head}test("sleeps past the ceiling", async () => { ${sleep(600)}; });\n`,
      "nested.test.mjs": `${head}describe("a suite", () => { it("sleeps past the ceiling inside it", async () => { ${sleep(600)}; }); });\n`,
      "done.test.mjs": `${head}test("calls back past the ceiling", (t, done) => { setTimeout(done, 600); });\n`,
      "allowed.test.mjs": `${head}test("sleeps within its budget", async (t) => { budget(t, 2, "${decision}"); ${sleep(600)}; });\nit("is quick", () => {});\n`,
      "over-budget.test.mjs": `${head}test("sleeps past its own budget", async (t) => { budget(t, 0.3, "${decision}"); ${sleep(600)}; });\n`,
      "uncited.test.mjs": `${head}test("cites no decision", (t) => { budget(t, 2, "d-00000000"); });\n`,
      "unbounded.test.mjs": `${head}test("asks for no ceiling", (t) => { budget(t, Infinity, "${decision}"); console.log("THE BODY RAN ON"); });\n`,
    },
    { COHERENCE_TEST_CEILING_SECONDS: "0.2" },
  );
  const failed = (name: string, pattern: RegExp): void => {
    const run = runs.get(name)!;
    assert.notEqual(run.status, 0, `${name}: ${run.output}`);
    assert.match(run.output, pattern, name);
  };
  failed("slow.test.mjs", /time budget: "sleeps past the ceiling" took 0\.\d s, over the unit suite's ceiling of 0\.2 s/);
  failed("slow.test.mjs", /budget\(t, <seconds>, "<decision id>"\)/);
  failed("slow.test.mjs", /location: '\S*slow\.test\.mjs:3:\d+'/);
  failed("nested.test.mjs", /time budget: "sleeps past the ceiling inside it" took 0\.\d s/);
  failed("done.test.mjs", /time budget: "calls back past the ceiling" took 0\.\d s/);
  failed("over-budget.test.mjs", new RegExp(`time budget: "sleeps past its own budget" took 0\\.\\d s, over its declared budget of 0\\.3 s \\(${decision}\\)`));
  failed("uncited.test.mjs", /cites d-00000000, which is no decision in this repository's journal/);
  failed("unbounded.test.mjs", /a test's budget is a number of seconds above 0 and at most 120, not Infinity/);
  assert.doesNotMatch(runs.get("unbounded.test.mjs")!.output, /THE BODY RAN ON/, "a malformed budget stops the test where it is declared");
  const allowed = runs.get("allowed.test.mjs")!;
  assert.equal(allowed.status, 0, allowed.output);
});

test("a unit test file that reads Coherence's own tree fails, naming each read; a question about one named file does not", { timeout: 120_000 }, async () => {
  const runs = await runFixtures({
    "tree.test.mjs": `import { test } from "node:test";
import { spawnSync } from "node:child_process";
test("lists the repository", () => { spawnSync("git", ["ls-files"], { cwd: ${JSON.stringify(REPOSITORY)} }); });
`,
    "named.test.mjs": `import { test } from "node:test";
import { spawnSync } from "node:child_process";
test("asks about one file", () => { spawnSync("git", ["ls-files", "--", "package.json"], { cwd: ${JSON.stringify(REPOSITORY)} }); });
`,
  });
  const tree = runs.get("tree.test.mjs")!;
  assert.notEqual(tree.status, 0, tree.output);
  assert.match(tree.output, /whole tree: \S*tree\.test\.mjs read Coherence's own tree 1 time\(s\)/);
  assert.match(tree.output, /"lists the repository": git ls-files/);
  assert.match(tree.output, /bench job/);
  const named = runs.get("named.test.mjs")!;
  assert.equal(named.status, 0, named.output);
});
