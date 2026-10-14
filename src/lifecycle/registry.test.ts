/**
 * A registry at the repository top opts in two leaves of a monorepo: one
 * with a config of its own overriding a key, one with none, beside a stray
 * nested config the registry does not list and a folder outside both.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { runHook } from "./hook.ts";
import { projectRoot, vocabularyFacts } from "./project.ts";
import { adopt, AdoptError } from "./adopt.ts";
import { readEnforcementConfig } from "../enforcement/config.ts";
import { configIgnore, configReferences } from "../adapters/project-files.ts";
import { countingGit } from "../adapters/git-count-fixture.ts";
import { stopWarmServers } from "../enforcement/server-fixture.ts";
import { cli as inProcess } from "./cli-fixture.ts";

const spec = (name: string) => `# ${name}\n\nThe ${name} product.\n\n## invariants\n- ${name} door: ${name.toUpperCase()}_ROWS leave only through door.\n  protects: ${name.toUpperCase()}_ROWS\n  chokepoint: door\n  because: a fixture\n  kinds: none\n`;
const practice = (name: string) => `- ${name}: Look before a change.\n  when: edit **/*.ts\n  step: list the folder\n  learned: d-0000abcd\n  because: a fixture\n`;

function git(root: string, ...args: string[]): string {
  return spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).stdout;
}

function repository(files: Record<string, string>): string {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "coherence-registry-")));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(top, path)), { recursive: true });
    writeFileSync(join(top, path), text);
  }
  git(top, "init", "-q");
  git(top, "add", "-A");
  git(top, "commit", "-q", "-m", "seed");
  return top;
}

const REGISTRY = {
  projects: ["products/notebooks", "products/errors"],
  language: "typescript",
  ignore: ["generated", "products/notebooks/legacy", "libs"],
  wellKnown: ["Acme"],
  latencyBudget: 5,
  references: ["libs/shared"],
  tests: [{ test: "node --test --test-name-pattern {filter}", testMatch: "# pass [1-9]", cwd: "." }],
};

/** The fixture: notebooks overrides latencyBudget, wellKnown and the test group; errors has no config; stray is not listed; libs/other is outside. */
function monorepo(): string {
  return repository({
    "coherence.config.json": JSON.stringify(REGISTRY, null, 4) + "\n",
    ".claude/settings.json": "{}\n",
    "products/notebooks/coherence.config.json": JSON.stringify({ name: "notebooks", latencyBudget: 2, wellKnown: ["Nb"], test: "npx vitest run -t {filter}" }) + "\n",
    "products/notebooks/Notebooks.spec.md": spec("notebooks"),
    "products/notebooks/Notebooks.practice.md": practice("look at notebooks"),
    "products/notebooks/src/door.ts": "export const NOTEBOOKS_ROWS = [1];\nexport function door(): number[] { return NOTEBOOKS_ROWS; }\n",
    "products/errors/Errors.spec.md": spec("errors"),
    "products/errors/Errors.practice.md": practice("look at errors"),
    "products/errors/src/door.ts": "export const ERRORS_ROWS = [1];\nexport function door(): number[] { return ERRORS_ROWS; }\n",
    "products/stray/coherence.config.json": JSON.stringify({ name: "stray" }) + "\n",
    "products/stray/Stray.spec.md": spec("stray"),
    "products/stray/Stray.practice.md": practice("look at stray"),
    "products/stray/src/door.ts": "export const STRAY_ROWS = [1];\n",
    "libs/other/Other.practice.md": practice("look at other"),
    "libs/other/x.ts": "export const x = 1;\n",
  });
}

const context = (stdout: string): string => (stdout.trim() === "" ? "" : (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "");

test("a registry leaf inherits the registry's keys, its own config overriding key by key, and inherited paths resolve against the file that declared them", async () => {
  const top = monorepo();
  try {
    const notebooks = join(top, "products/notebooks");
    const errors = join(top, "products/errors");
    assert.equal(readEnforcementConfig(notebooks).latencyBudget, 2, "the leaf's own value wins");
    assert.equal(readEnforcementConfig(errors).latencyBudget, 5, "a leaf with no config inherits");
    const inherited = readEnforcementConfig(errors).tests[0]!;
    assert.equal(inherited.cwd, "../..", "the registry's cwd \".\" is the repository top, rebased to the leaf");
    assert.equal(resolve(errors, inherited.cwd!), top);
    assert.equal(inherited.testMatch?.source, "# pass [1-9]");
    const own = readEnforcementConfig(notebooks).tests[0]!;
    assert.deepEqual([own.test, own.cwd, own.testMatch], ["npx vitest run -t {filter}", undefined, undefined], "a leaf declaring a test key replaces the whole test group");
    assert.deepEqual(configIgnore(notebooks), ["generated", "legacy", "libs"], "ignore concatenates; a registry path inside the leaf is rebased to it");
    assert.deepEqual(configIgnore(errors), ["generated", "libs"], "and one outside the leaf is dropped");
    assert.deepEqual(configReferences(errors), ["libs/shared"], "references stay relative to the repository top");
    assert.deepEqual((await vocabularyFacts(notebooks)).wellKnown, ["Acme", "Nb"], "wellKnown concatenates");
    assert.deepEqual(await vocabularyFacts(errors), { name: undefined, wellKnown: ["Acme"] }, "name is never inherited");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("with a registry, events from the repository top route to the leaf with the longest listed prefix, and anything in no leaf is ignored", async () => {
  const top = monorepo();
  try {
    const edit = (file: string) => ({ cwd: top, session_id: "s1", tool_name: "Edit", tool_input: { file_path: join(top, file), new_string: "x" } });
    const start = await runHook("SessionStart", { cwd: top, session_id: "s1" }, top);
    assert.match(context(start.stdout), /holds 2 projects \(products\/errors, products\/notebooks\)/, "a start above two leaves names them");
    const inNotebooks = await runHook("PreToolUse", edit("products/notebooks/src/door.ts"), top);
    inNotebooks.commit?.();
    assert.match(context(inNotebooks.stdout), /notebooks door/, "orient of the leaf, at its first tool use");
    assert.match(context(inNotebooks.stdout), /look at notebooks/, "its practice");
    assert.doesNotMatch(context(inNotebooks.stdout), /errors door|look at errors|stray|look at other/);
    const inErrors = await runHook("PreToolUse", edit("products/errors/src/door.ts"), top);
    inErrors.commit?.();
    assert.match(context(inErrors.stdout), /errors door/, "a leaf with no config of its own is a project");
    assert.match(context(inErrors.stdout), /look at errors/);
    const stop = await runHook("Stop", { cwd: top, session_id: "s1" }, top);
    assert.match(stop.stdout, /look at errors/, "a stop above both leaves regulates the one the session last entered");
    assert.doesNotMatch(stop.stdout, /look at notebooks/);
    for (const file of ["products/stray/src/door.ts", "libs/other/x.ts"]) {
      const result = await runHook("PreToolUse", edit(file), top);
      result.commit?.();
      assert.deepEqual({ stdout: result.stdout, exit: result.exit }, { stdout: "", exit: 0 }, `${file} is in no leaf`);
    }
    assert.ok(existsSync(join(top, "products/notebooks/.coherence")) && existsSync(join(top, "products/errors/.coherence")), "each leaf keeps its own records");
    for (const dir of ["", "products/stray", "libs/other"]) assert.ok(!existsSync(join(top, dir, ".coherence")), `nothing written in ${dir || "the top"}`);
    assert.equal(projectRoot(join(top, "products/errors/src")), join(top, "products/errors"), "a command in a leaf with no config acts on the leaf, never walking up to the registry");
    assert.equal(projectRoot(join(top, "products/notebooks")), join(top, "products/notebooks"));
  } finally {
    // The stop reaches a leaf's instrument through a warm server, which outlives the test unless it is stopped.
    await stopWarmServers(top);
    rmSync(top, { recursive: true, force: true });
  }
});

test("the first tool use inside a nested project warms its instrument, once", async () => {
  const top = monorepo();
  try {
    const warmed: string[] = [];
    const options = { warm: (root: string) => void warmed.push(root) };
    const edit = { cwd: top, session_id: "s1", tool_name: "Edit", tool_input: { file_path: join(top, "products/errors/src/door.ts"), new_string: "x" } };
    for (let i = 0; i < 2; i++) (await runHook("PreToolUse", edit, top, options)).commit?.();
    assert.deepEqual(warmed, [join(top, "products/errors")]);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("an event outside every leaf of a registry spawns no git and writes nothing", async () => {
  const top = monorepo();
  const counted = countingGit();
  try {
    const outside = join(top, "libs/other");
    for (const event of ["PreToolUse", "PostToolUse"] as const) {
      for (const input of [
        { tool_name: "Edit", tool_input: { file_path: join(outside, "x.ts"), new_string: "y" } },
        { tool_name: "Bash", tool_input: { command: "ls" }, cwd: outside },
      ]) {
        const result = await runHook(event, { cwd: top, session_id: "s1", ...input }, top);
        result.commit?.();
        assert.equal(result.stdout, "");
      }
    }
    assert.deepEqual(counted.calls(), [], "the registry's list decides, with no listing of the repository");
    assert.ok(!existsSync(join(top, ".coherence")) && !existsSync(join(outside, ".coherence")));
  } finally {
    counted.restore();
    rmSync(top, { recursive: true, force: true });
  }
});

test("spec --check names a nested config the registry does not list as adopted there but not opted in, at the top and in a leaf", async () => {
  const top = monorepo();
  try {
    const check = (cwd: string) => inProcess(["spec", "--check"], { cwd });
    const atTop = await check(top);
    assert.equal(atTop.status, 1, atTop.stdout + atTop.stderr);
    assert.match(atTop.stdout, /2 projects; the rest of the repository is outside every project/);
    assert.match(atTop.stdout, /products\/errors: 1 component, 1 bullet/);
    assert.match(atTop.stdout, /PROBLEM {2}products\/stray\/coherence\.config\.json {2}adopted here but not opted in/);
    assert.doesNotMatch(atTop.stdout, /stray door/, "the stray's spec is never read");
    assert.match((await check(join(top, "products/errors"))).stdout, /adopted here but not opted in/, "a leaf's check names it too");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("adopt lists a folder in the registry, keeping its layout, creates one when there is none, and refuses every bad case", async () => {
  const top = monorepo();
  const bare = repository({ "apps/billing/x.ts": "export const x = 1;\n", "apps/other/y.ts": "export const y = 1;\n" });
  const whole = repository({ "coherence.config.json": "{ \"name\": \"whole\" }\n", "apps/billing/x.ts": "export const x = 1;\n" });
  try {
    const added = adopt(top, "libs/other");
    assert.equal(added.folder, "libs/other");
    const text = readFileSync(join(top, "coherence.config.json"), "utf8");
    assert.deepEqual(JSON.parse(text).projects, ["products/notebooks", "products/errors", "libs/other"]);
    assert.match(text, /^ {4}"projects"/m, "the four-space indentation is kept");
    assert.deepEqual(Object.keys(JSON.parse(text)), Object.keys(REGISTRY), "and the key order");
    assert.ok(text.endsWith("}\n"));
    const created = adopt(join(bare, "apps"), "billing");
    assert.equal(created.created, true);
    assert.deepEqual(JSON.parse(readFileSync(join(bare, "coherence.config.json"), "utf8")), { projects: ["apps/billing"] });
    const refused = (cwd: string, path: string, why: RegExp) => assert.throws(() => adopt(cwd, path), (e: unknown) => e instanceof AdoptError && why.test(e.message), `${path}: ${why}`);
    refused(top, tmpdir(), /not a folder below the repository top|in no git repository/);
    refused(top, ".", /not a folder below the repository top/);
    refused(top, "products/errors", /already listed/);
    refused(top, "products/notebooks/src", /lies inside products\/notebooks/);
    refused(top, "products", /holds products\/notebooks/);
    refused(top, "missing", /not a folder/);
    refused(whole, "apps/billing", /whole-repository project/);
    const cli = await inProcess(["adopt", "apps/other"], { cwd: bare });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /query practice "adopt Coherence"/, "the next step is the adopt practice");
  } finally {
    for (const dir of [top, bare, whole]) rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks install with a registry writes the host settings once, at the repository top, and an ignore file in each leaf", async () => {
  const top = monorepo();
  try {
    const run = await inProcess(["hooks", "install", "--host", "claude", "--command", "npx coherence"], { cwd: join(top, "products/errors"), env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(readFileSync(join(top, ".claude/settings.json"), "utf8"), /npx coherence hook Stop/);
    assert.ok(!existsSync(join(top, "products/errors/.claude")), "never a leaf's own settings");
    for (const leaf of ["products/notebooks", "products/errors"]) assert.ok(existsSync(join(top, leaf, ".coherence/.gitignore")), leaf);
    assert.ok(!existsSync(join(top, ".coherence")), "the registry's top is no project");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});
