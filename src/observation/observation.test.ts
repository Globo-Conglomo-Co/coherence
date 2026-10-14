/**
 * Observation over a small TypeScript project written into a temporary
 * folder: component front references components back and side; one test
 * crosses front -> back, one fails inside back after crossing front -> back,
 * and nothing crosses front -> side. (The folders are not one letter long:
 * defect df-f7ccaa6d, componentOf ties "." with a one-character folder.)
 * The observed pass runs through the real node:test runner,
 * the real reporter, the preload, and the TypeScript adapter, in one
 * invocation the fixture's command counts. Staleness, the per-run path, and
 * the wording are proved on the record and the readings. The Python fixture
 * runs only where coverage.py is installed, and says so when it is not.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { TypeScriptAdapter } from "../adapters/typescript.ts";
import { PythonAdapter } from "../adapters/python.ts";
import { formatRun } from "../enforcement/cli.ts";
import { cli } from "../lifecycle/cli-fixture.ts";
import { readEnforcementConfig } from "../enforcement/config.ts";
import { performRun } from "../enforcement/run.ts";
import { loadSpecModel } from "../spec/model.ts";
import { createObserver, executedFromIstanbul, type Capture } from "./capture.ts";
import { framesOf, siteExecuted, type Span } from "./map.ts";
import { buildObservation, symbolCrossed } from "./observe.ts";
import type { InterfaceSymbol } from "./interfaces.ts";
import { answerFailures, answerObserved } from "./observed.ts";
import { freshness, loadObservations, observedEvidence, type ObservationRecord } from "./record.ts";

const REPORTER = fileURLToPath(new URL("../enforcement/node-test-reporter.ts", import.meta.url));

const TSCONFIG = `{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true, "noEmit": true, "allowImportingTsExtensions": true }, "include": ["**/*.ts"] }\n`;

const USE = `import { beta, breaks } from "../back/beta.ts";
import { gamma } from "../side/gamma.ts";

export function useBeta(): number {
  return beta() + 1;
}

export function useGamma(): number {
  return gamma() + 1;
}

export function useBreaks(): number {
  return breaks() + 1;
}
`;

const BETA = `export function beta(): number {
  return 2;
}

export function breaks(): number {
  throw new Error("b broke");
}
`;

const GAMMA = `export function gamma(): number {
  return 3;
}
`;

const TESTS = `import assert from "node:assert/strict";
import { test } from "node:test";
import { useBeta, useBreaks } from "../front/use.ts";

test("crosses a to b", () => {
  assert.equal(useBeta(), 3);
});

test("fails inside b", () => {
  assert.equal(useBreaks(), 0);
});
`;

const SPEC = `# Fixture

Three components and the tests that cross them.

## invariants
- a reaches b: a uses b's beta.
  over: every use of beta from a
  via: crosses a to b
  because: the fixture's one exercised component interface
  kinds: none
- b holds: b's breaks returns.
  over: every call of breaks
  via: fails inside b
  because: the fixture's failing test, inside b after crossing front -> back
  kinds: none
`;

let root: string;
let adapter: TypeScriptAdapter;

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

function git(...args: string[]): string {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "coherence-observation-")));
  write("package.json", `{ "type": "module" }\n`);
  write("tsconfig.json", TSCONFIG);
  // A string command, so the shell counts every invocation of the runner in invocations.log.
  const node = JSON.stringify(process.execPath);
  write(
    "coherence.config.json",
    JSON.stringify({
      language: "typescript",
      testJson: `echo run >> invocations.log && ${node} --disable-warning=ExperimentalWarning --test --test-concurrency=1 --test-reporter=${JSON.stringify(REPORTER)} --test-reporter-destination={out} --test-name-pattern={filter} tests/use.test.ts`,
    }),
  );
  // .coherence is not ignored: the run appends to it during the pass, and that must not make the observation dirty.
  write(".gitignore", "invocations.log\n");
  write("Fixture.spec.md", SPEC);
  write("front/Front.spec.md", "# A\n\nThe component that uses b and c.\n");
  write("back/Back.spec.md", "# B\n\nThe component a crosses into.\n");
  write("side/Side.spec.md", "# C\n\nThe component nothing reaches at runtime.\n");
  write("front/use.ts", USE);
  write("back/beta.ts", BETA);
  write("side/gamma.ts", GAMMA);
  write("tests/use.test.ts", TESTS);
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
  adapter = new TypeScriptAdapter(root);
});

after(async () => {
  await adapter.close();
  rmSync(root, { recursive: true, force: true });
});

/** Run the observed pass over the fixture as the CLI would, outside any test context of this runner. */
async function observedRun(session: string): Promise<Awaited<ReturnType<typeof performRun>>> {
  const context = process.env["NODE_TEST_CONTEXT"];
  delete process.env["NODE_TEST_CONTEXT"];
  try {
    return await performRun(root, { session, agent: "observation", adapter, form: "totality oracle", observe: true });
  } finally {
    if (context !== undefined) process.env["NODE_TEST_CONTEXT"] = context;
  }
}

/** The fixture's latest observation, observing it first when a test runs alone (a refutation selects one test by name). */
async function latest(): Promise<ObservationRecord> {
  if (loadObservations(root).records.length === 0) await observedRun("fixture");
  const { records } = loadObservations(root);
  assert.ok(records.length > 0, "an observation was appended");
  return records[records.length - 1]!;
}

test("an observed pass records per test the components executed and the component interfaces co-executed: front -> back crossed, front -> side never observed", async () => {
  const outcome = await observedRun("observed-fixture");
  assert.ok(outcome.observation !== undefined, outcome.observationSkipped ?? "no observation");
  const record = outcome.observation.record;
  assert.equal(record.source.runner, "node:test");
  assert.equal(record.source.attribution, "per test");
  const crossing = record.tests.find((t) => t.name === "crosses a to b")!;
  assert.deepEqual(crossing.components, ["back", "front"]);
  assert.deepEqual(crossing.interfaces, ["front -> back"]);
  const ab = record.interfaces.find((i) => i.id === "front -> back")!;
  const ac = record.interfaces.find((i) => i.id === "front -> side")!;
  assert.equal(ab.exercisedBy, 2, "both tests co-executed front -> back");
  assert.equal(ac.exercisedBy, 0, "no test executed gamma");
  assert.equal(record.totals.neverObserved, 1);
  const text = answerObserved([record], record.commit);
  assert.match(text, /front -> back {2}exercised by 2 tests \(\w+, fresh\)/);
  assert.match(text, /front -> side {2}never observed \(\w+, fresh\)/);
  assert.match(formatRun(outcome), /observation recorded in \.coherence\/observations\/observed-fixture\.jsonl: test pass \(node:test, per test\)/);
});

test("an observed pass spawns the runner once", async () => {
  rmSync(join(root, "invocations.log"), { force: true });
  const outcome = await observedRun("once");
  assert.ok(outcome.observation !== undefined);
  const invocations = readFileSync(join(root, "invocations.log"), "utf8").trim().split("\n");
  assert.equal(invocations.length, 1, "the observed pass is the batched pass's one invocation");
  assert.ok(outcome.record.invariants.every((e) => e.mode === "batched"));
  assert.ok(outcome.observation.record.tests.length === 2 && outcome.observation.record.tests.every((t) => t.components !== undefined), "both tests' coverage came from that one invocation");
});

test("a component interface is crossed when both ends co-executed in one test, and the record says co-executed", async () => {
  const record = await latest();
  assert.equal(record.relation, "co-executed");
  // Both ends, or no crossing: the symbol's body alone, or the using site alone, is not a crossing.
  const symbol: InterfaceSymbol = {
    from: "front",
    to: "back",
    symbol: "beta",
    file: "back/beta.ts",
    range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
    declares: "body",
    sites: [
      { file: "front/use.ts", line: 0, character: 9, form: "import" },
      { file: "front/use.ts", line: 4, character: 9 },
    ],
  };
  const body: Span = { start: { line: 0, character: 7 }, end: { line: 2, character: 1 }, count: 1, kind: "function" };
  const user = (count: number): Span => ({ start: { line: 3, character: 7 }, end: { line: 5, character: 1 }, count, kind: "function" });
  assert.equal(symbolCrossed(symbol, new Map([["back/beta.ts", [body]], ["front/use.ts", [user(1)]]])), true);
  assert.equal(symbolCrossed(symbol, new Map([["back/beta.ts", [body]], ["front/use.ts", [user(0)]]])), false, "the body ran, the using site did not");
  assert.equal(symbolCrossed(symbol, new Map([["front/use.ts", [user(1)]]])), false, "the using site ran, the body did not");
  assert.equal(symbolCrossed({ ...symbol, sites: [symbol.sites[0]!] }, new Map([["back/beta.ts", [body]], ["front/use.ts", [user(1)]]])), false, "an import specifier is never evidence");
  const text = [answerObserved([record], record.commit), answerFailures([record], record.commit)].join("\n");
  assert.match(text, /co-executed, never called/);
  const claimsACall = text.replace(/never called/g, "").match(/\bcall(s|ed|er)?\b/);
  assert.equal(claimsACall, null, "no reading says one component called another");
  // A site at a module's top level is load time: never evidence for a test.
  const spans: Span[] = [
    { start: { line: 0, character: 0 }, end: { line: 20, character: 0 }, count: 1, kind: "module" },
    { start: { line: 3, character: 0 }, end: { line: 5, character: 1 }, count: 1, kind: "function" },
    { start: { line: 7, character: 0 }, end: { line: 9, character: 1 }, count: 0, kind: "function" },
  ];
  assert.equal(siteExecuted(spans, { line: 0, character: 9 }), "load time");
  assert.equal(siteExecuted(spans, { line: 4, character: 9 }), "executed");
  assert.equal(siteExecuted(spans, { line: 8, character: 9 }), "not executed");
});

test("a failure records what broke, the likely site, and the region apart", async () => {
  const record = await latest();
  const failing = record.tests.find((t) => t.name === "fails inside b")!;
  assert.equal(failing.verdict, "fail");
  assert.deepEqual(failing.invariants, ["./b holds"], "what broke: the invariant whose totality oracle it is");
  assert.equal(failing.likelySite?.label, "likely site");
  assert.equal(failing.likelySite?.file, "back/beta.ts");
  assert.equal(failing.likelySite?.line, 6);
  assert.equal(failing.likelySite?.symbol, "breaks");
  assert.equal(failing.likelySite?.component, "back");
  assert.deepEqual(failing.likelySite?.interfaces, ["front -> back"]);
  assert.deepEqual(failing.components, ["back", "front"], "the region it touched");
  assert.deepEqual(failing.interfaces, ["front -> back"]);
  const text = answerFailures([record], record.commit, { commit: "HEAD~1", changed: ["back/beta.ts"] });
  assert.match(text, /what broke: invariant \.\/b holds/);
  assert.match(text, /likely site \(evidence, not proof\): back\/beta\.ts:6 in breaks, component back, carried by front -> back/);
  assert.match(text, /region: components back, front; co-executed front -> back/);
  assert.match(text, /suspects since HEAD~1: front -> back/);
  const unrelated = answerFailures([record], record.commit, { commit: "HEAD~1", changed: ["side/gamma.ts"] });
  assert.match(unrelated, /suspects since HEAD~1: none/);
  const evidence = observedEvidence([record], record.commit, "front", "back");
  assert.ok(evidence.kind === "exercised");
  assert.deepEqual(evidence.failing, ["fails inside b"]);
  assert.deepEqual(evidence.likelySiteOf, ["fails inside b"]);
});

test("an observation from another commit, or from a dirty tree, is stale in every reader", async () => {
  const record = await latest();
  const head = record.commit;
  assert.equal(freshness(record, head).fresh, true);
  const older: ObservationRecord = { ...record, commit: "0000000" };
  const dirty: ObservationRecord = { ...record, dirty: true };
  for (const stale of [older, dirty]) {
    assert.equal(freshness(stale, head).fresh, false);
    const text = answerObserved([stale], head);
    assert.match(text, /STALE: captured at/);
    assert.doesNotMatch(text, /\bfresh\b/, "a stale observation never reads as current");
    assert.match(answerFailures([stale], head), /STALE/);
    const evidence = observedEvidence([stale], head, "front", "back");
    assert.ok(evidence.kind === "exercised" && !evidence.freshness.fresh);
  }
  // The head moves on: the same record, read later, is stale.
  write("side/gamma.ts", GAMMA.replace("3", "4"));
  git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qam", "move the head");
  const moved = await cli(["query", "observed"], { cwd: root });
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /STALE: captured at \w+; the head is \w+/);
});

test("a runner that attributes coverage only per run is recorded per run, never per test", () => {
  const coverage = {
    [join(root, "back/beta.ts")]: {
      path: join(root, "back/beta.ts"),
      fnMap: { "0": { name: "beta", loc: { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } } } },
      f: { "0": 1 },
      statementMap: {},
      s: {},
    },
  };
  const run = executedFromIstanbul(coverage, root);
  assert.deepEqual(run.map((f) => f.file), ["back/beta.ts"]);
  const capture: Capture = {
    runner: "vitest",
    attribution: "per run",
    note: "vitest with @vitest/coverage-v8: coverage for the whole run",
    tests: [{ file: "tests/use.test.ts", name: "crosses a to b", fullName: "crosses a to b", verdict: "pass" }],
    run,
  };
  const config = readEnforcementConfig(root);
  const record = buildObservation({
    root,
    realRoot: root,
    capture,
    map: { symbols: [], entrances: [] },
    model: loadSpecModel(root, { runs: false }),
    config,
    vias: [],
    at: new Date().toISOString(),
    session: "per-run",
    agent: "observation",
    binding: {},
    commit: null,
    dirty: false,
    latency: { pass: 0, map: 0 },
  });
  assert.equal(record.source.attribution, "per run");
  assert.equal(record.tests[0]!.components, undefined, "no per-test region is fabricated");
  assert.deepEqual(record.run?.components, ["back"]);
  // A vitest without a coverage provider observes nothing and says so.
  const bare = createObserver(root, { ...config, testJson: ["npx", "vitest", "run", "--reporter=json", "--outputFile={out}", "-t", "{filter}"] });
  assert.match(bare.collect().note, /no coverage provider is installed/);
});

test("an entrance is exercised when some test executed its handler's body, and never observed otherwise", () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } };
  const ran: Span = { start: { line: 0, character: 7 }, end: { line: 2, character: 1 }, count: 1, kind: "function", name: "beta" };
  const capture: Capture = {
    runner: "node:test",
    attribution: "per test",
    note: "hand-made",
    tests: [{ file: "tests/use.test.ts", name: "enters", fullName: "enters", verdict: "pass", executed: [{ file: "back/beta.ts", spans: [ran] }] }],
  };
  const record = buildObservation({
    root,
    realRoot: root,
    capture,
    map: {
      symbols: [],
      entrances: [
        { component: "back", name: "beta door", handler: "beta", file: "back/beta.ts", range },
        { component: "side", name: "gamma door", handler: "gamma", file: "side/gamma.ts", range },
      ],
    },
    model: loadSpecModel(root, { runs: false }),
    config: readEnforcementConfig(root),
    vias: [],
    at: new Date().toISOString(),
    session: "entrances",
    agent: "observation",
    binding: {},
    commit: "abc1234",
    dirty: false,
    latency: { pass: 0, map: 0 },
  });
  assert.deepEqual(record.tests[0]!.entrances, ["back/beta door"]);
  const text = answerObserved([record], "abc1234");
  assert.match(text, /entrances: 1 of 2 with a handler some test executed/);
  assert.match(text, /back\/beta door {2}handler beta executed by 1 test \(fresh\)/);
  assert.match(text, /side\/gamma door {2}handler gamma never observed/);
});

test("stack frames read innermost first from V8 and from Python", () => {
  assert.deepEqual(framesOf("Error: x\n    at breaks (file:///p/b/beta.ts:6:9)\n    at useBreaks (file:///p/a/use.ts:13:10)"), [
    { path: "/p/b/beta.ts", line: 6 },
    { path: "/p/a/use.ts", line: 13 },
  ]);
  assert.deepEqual(framesOf('Traceback:\n  File "/p/tests/test_use.py", line 4, in test_x\n  File "/p/b/beta.py", line 5, in breaks'), [
    { path: "/p/b/beta.py", line: 5 },
    { path: "/p/tests/test_use.py", line: 4 },
  ]);
});

/* ---------------------------------------------------------------- Python */

const TEST_PYTHON = fileURLToPath(new URL("../../.venv/bin/python", import.meta.url));

function pythonWithCoverage(): { python: string } | { skip: string } {
  const python = process.env["COHERENCE_PYTHON"] || TEST_PYTHON;
  const probe = spawnSync(python, ["-c", "import coverage, pytest"], { encoding: "utf8" });
  if (probe.status !== 0) return { skip: `coverage.py and pytest are not both importable in ${python}; set COHERENCE_PYTHON to an interpreter with both to observe the Python fixture` };
  return { python };
}

test("the Python fixture observed through coverage.py dynamic contexts, one context per test", async (t) => {
  const found = pythonWithCoverage();
  if ("skip" in found) {
    t.skip(found.skip);
    return;
  }
  const py = realpathSync(mkdtempSync(join(tmpdir(), "coherence-observation-python-")));
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(py, path)), { recursive: true });
    writeFileSync(join(py, path), text, "utf8");
  };
  put("coherence.config.json", JSON.stringify({ language: "python", testDir: "tests", testFilterForm: "pytest", testJson: [found.python, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-k", "{filter}", "--junitxml={out}", "tests"] }));
  put("Fixture.spec.md", SPEC.replace("via: crosses a to b", "via: test_crosses_a_to_b").replace("via: fails inside b", "via: test_fails_inside_b"));
  put("front/Front.spec.md", "# A\n\nThe component that uses b and c.\n");
  put("back/Back.spec.md", "# B\n\nThe component a crosses into.\n");
  put("side/Side.spec.md", "# C\n\nThe component nothing reaches at runtime.\n");
  put("front/__init__.py", "");
  put("back/__init__.py", "");
  put("side/__init__.py", "");
  put("front/use.py", "from back.beta import beta, breaks\nfrom side.gamma import gamma\n\n\ndef use_beta():\n    return beta() + 1\n\n\ndef use_gamma():\n    return gamma() + 1\n\n\ndef use_breaks():\n    return breaks() + 1\n");
  put("back/beta.py", 'def beta():\n    return 2\n\n\ndef breaks():\n    raise ValueError("b broke")\n');
  put("side/gamma.py", "def gamma():\n    return 3\n");
  put("tests/test_use.py", "from front.use import use_beta, use_breaks\n\n\ndef test_crosses_a_to_b():\n    assert use_beta() == 3\n\n\ndef test_fails_inside_b():\n    assert use_breaks() == 0\n");
  const pyAdapter = new PythonAdapter(py);
  try {
    const outcome = await performRun(py, { session: "python", agent: "observation", adapter: pyAdapter, form: "totality oracle", observe: true });
    assert.ok(outcome.observation !== undefined, outcome.observationSkipped ?? "no observation");
    const record = outcome.observation.record;
    assert.equal(record.source.runner, "pytest");
    assert.equal(record.source.attribution, "per test", record.source.note);
    const crossing = record.tests.find((x) => x.name === "test_crosses_a_to_b")!;
    assert.deepEqual(crossing.components, ["back", "front"]);
    assert.deepEqual(crossing.interfaces, ["front -> back"]);
    assert.equal(record.interfaces.find((i) => i.id === "front -> side")?.exercisedBy, 0);
    const failing = record.tests.find((x) => x.name === "test_fails_inside_b")!;
    assert.equal(failing.verdict, "fail");
    assert.equal(failing.likelySite?.file, "back/beta.py");
    assert.equal(failing.likelySite?.symbol, "breaks");
    assert.deepEqual(failing.invariants, ["./b holds"]);
  } finally {
    await pyAdapter.close();
    rmSync(py, { recursive: true, force: true });
  }
});
