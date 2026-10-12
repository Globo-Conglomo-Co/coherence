/**
 * `run --each` over a small project whose tests run under the real node:test
 * runner: one test leaves state behind in its module, the next reads it. In
 * the one batched invocation both pass; alone, the reader fails. The per-test
 * confirmation must catch it, append its verdicts as a second run, and exit
 * non-zero (df-9e673484).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runCommand } from "./cli.ts";
import { entryKey, latestByEnforcement, loadRuns } from "./record.ts";

const LEFTOVERS = `import test from "node:test";
import assert from "node:assert/strict";
let leftover;
test("writes the leftover", () => { leftover = "left"; });
test("reads the leftover", () => { assert.equal(leftover, "left", "nothing was left behind"); });
test("stands alone", () => { assert.equal(1 + 1, 2); });
`;

const SPEC = `# Fixture

Three tests, one of which leans on another.

## invariants
- writer: The writer leaves its value.
  over: the one module
  via: writes the leftover
  because: fixture
  kinds: none
- reader: The reader finds the value.
  over: the one module
  via: reads the leftover
  because: fixture
  kinds: none
- loner: The loner needs nobody.
  over: the one module
  via: stands alone
  because: fixture
  kinds: none
`;

test("run --each runs each batched totality oracle's test in its own invocation and catches one that passes only on an earlier test's leftovers", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "coherence-each-"));
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, "utf8");
  };
  const reporter = fileURLToPath(new URL("./node-test-reporter.ts", import.meta.url));
  write("tests/leftovers.test.mjs", LEFTOVERS);
  write("Fixture.spec.md", SPEC);
  write(
    "coherence.config.json",
    JSON.stringify({
      language: "typescript",
      testDir: "tests",
      test: "node --disable-warning=ExperimentalWarning --test --test-concurrency=1 --test-name-pattern={filter} tests/leftovers.test.mjs",
      testMatch: "# pass [1-9][0-9]*",
      testJson: ["node", "--disable-warning=ExperimentalWarning", "--test", "--test-concurrency=1", `--test-reporter=${reporter}`, "--test-reporter-destination={out}", "--test-name-pattern={filter}", "tests/leftovers.test.mjs"],
    }),
  );
  // The runner under test is node:test itself: its child must not report to this test's parent.
  const context = process.env["NODE_TEST_CONTEXT"];
  delete process.env["NODE_TEST_CONTEXT"];
  const out: string[] = [];
  const err: string[] = [];
  try {
    const code = await runCommand(["--each", "--session", "each-1", "--agent", "enforcement", "--json"], { cwd: root, out: (l) => out.push(l), err: (l) => err.push(l) });
    const json = JSON.parse(out.join("\n")) as { invariants: { name: string; verdict: string; mode: string }[]; each: { invariants: { name: string; verdict: string; mode: string; reason: string }[]; hidden: string[] } | null };
    const batched = Object.fromEntries(json.invariants.map((e) => [e.name, `${e.mode} ${e.verdict}`]));
    assert.deepEqual(batched, { writer: "batched pass", reader: "batched pass", loner: "batched pass" }, "in one invocation the reader passes on the writer's leftover");
    assert.ok(json.each !== null, `the per-test run was recorded: ${err.join("\n")}`);
    const alone = Object.fromEntries(json.each.invariants.map((e) => [e.name, `${e.mode} ${e.verdict}`]));
    assert.deepEqual(alone, { writer: "one-at-a-time pass", reader: "one-at-a-time fail", loner: "one-at-a-time pass" }, "alone, the reader fails");
    assert.deepEqual(json.each.hidden, ["./reader"], "the one that passed batched and fails alone is named");
    assert.match(json.each.invariants.find((e) => e.name === "reader")!.reason, /passed in the batched invocation, failed in its own/);
    assert.equal(code, 1, "a test that cannot pass alone is not confirmed: the command exits non-zero");

    const loaded = loadRuns(root);
    assert.equal(loaded.records.length, 2, "the batched pass and the per-test pass are two appended runs");
    assert.equal(latestByEnforcement(loaded.records).get(entryKey(".", "reader", "totality oracle"))!.verdict, "fail", "the per-test verdict is the latest, so the status view shows the defect");

    out.length = 0;
    const printed = await runCommand(["--each", "--session", "each-2", "--agent", "enforcement", "--invariant", "loner"], { cwd: root, out: (l) => out.push(l), err: (l) => err.push(l) });
    assert.equal(printed, 0, out.join("\n"));
    assert.match(out.join("\n"), /every totality oracle that passed batched passes alone/);
  } finally {
    if (context !== undefined) process.env["NODE_TEST_CONTEXT"] = context;
    rmSync(root, { recursive: true, force: true });
  }
});

test("run refuses an --invariant that names no bullet, running nothing, and takes a bullet by its component folder and name too", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "coherence-names-"));
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, "utf8");
  };
  write("tests/leftovers.test.mjs", LEFTOVERS);
  write("Fixture.spec.md", SPEC);
  write("coherence.config.json", JSON.stringify({ language: "typescript", testDir: "tests", test: "node --test --test-concurrency=1 --test-name-pattern={filter} tests/leftovers.test.mjs", testMatch: "# pass [1-9][0-9]*" }));
  const context = process.env["NODE_TEST_CONTEXT"];
  delete process.env["NODE_TEST_CONTEXT"];
  try {
    const out: string[] = [];
    const err: string[] = [];
    // One real name beside a misspelled one: before, the misspelled one was left out and the run passed on the other.
    const refused = await runCommand(["--invariant", "loner", "--invariant", "lonre", "--session", "names-1", "--agent", "enforcement"], { cwd: root, out: (l) => out.push(l), err: (l) => err.push(l) });
    assert.equal(refused, 64, `refused: ${out.join("\n")}`);
    assert.match(err.join("\n"), /no bullet is named "lonre"/);
    assert.deepEqual(loadRuns(root).records, [], "nothing ran, so no run was recorded");
    const taken: string[] = [];
    const byFolder = await runCommand(["--invariant", "./loner", "--session", "names-2", "--agent", "enforcement"], { cwd: root, out: (l) => taken.push(l), err: (l) => taken.push(l) });
    assert.equal(byFolder, 0, taken.join("\n"));
    assert.deepEqual(loadRuns(root).records.at(-1)!.invariants.map((e) => e.name), ["loner"], "the component folder and name select that bullet alone");
  } finally {
    if (context !== undefined) process.env["NODE_TEST_CONTEXT"] = context;
    rmSync(root, { recursive: true, force: true });
  }
});
