/**
 * Adopting one folder of a monorepo: coherence.config.json, specs and
 * .coherence live in apps/billing, nothing at the repository top, and the
 * rest of the repository is outside the project, whether the session starts
 * at the top (where the host reads its settings) or in the folder.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { budget } from "../enforcement/test-budgets.ts";
import { changedFiles, runHook } from "./hook.ts";
import { projectRoot } from "./project.ts";
import { patchFiles } from "../economy/trace.ts";
import { changedSince } from "../observation/observed.ts";
import { checkChokepoint } from "../enforcement/check.ts";
import { TypeScriptAdapter } from "../adapters/typescript.ts";
import { stopWarmServers } from "../enforcement/server-fixture.ts";
import { cli as inProcess } from "./cli-fixture.ts";

const BILLING_SPEC = [
  "# Billing",
  "",
  "Charges a card and keeps its numbers masked.",
  "",
  "## invariants",
  "- card numbers masked: A card number leaves the store only through mask.",
  "  protects: CARD_NUMBERS",
  "  chokepoint: mask",
  "  because: a raw card number must never reach a log",
  "  kinds: none",
  "",
].join("\n");

const OTHER_SPEC = "# Other\n\nAnother team's code.\n\n## invariants\n- outside door: OUTSIDE leaves only through door.\n  protects: OUTSIDE\n  chokepoint: door\n  because: a canary outside the project\n  kinds: none\n";

const practice = (name: string) => `- ${name}: Look before a change.\n  when: command ls | edit **/*.ts\n  step: list the folder\n  learned: d-0000abcd\n  because: a fixture\n`;

function git(root: string, ...args: string[]): string {
  return spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).stdout;
}

/** A repository whose one adopted folder is apps/billing, with another team's spec and practice in libs/other and the host's settings at the top. */
function monorepo(extra: Record<string, string> = {}): { top: string; billing: string } {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "coherence-monorepo-")));
  const files: Record<string, string> = {
    "README.md": "# Mono\n",
    ".claude/settings.json": "{}\n",
    "libs/other/Other.spec.md": OTHER_SPEC,
    "libs/other/Other.practice.md": practice("outside practice"),
    "libs/other/door.ts": "export const OUTSIDE = 1;\nexport function door(): number { return OUTSIDE; }\n",
    "apps/billing/coherence.config.json": JSON.stringify({ name: "billing" }) + "\n",
    "apps/billing/tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowImportingTsExtensions: true, noEmit: true, strict: true }, include: ["src/**/*.ts"] }) + "\n",
    "apps/billing/Billing.spec.md": BILLING_SPEC,
    "apps/billing/Billing.practice.md": practice("list before charging"),
    "apps/billing/src/store.ts": "export const CARD_NUMBERS: string[] = [\"4111111111111111\"];\n",
    "apps/billing/src/mask.ts": "import { CARD_NUMBERS } from \"./store.ts\";\nexport function mask(): string[] {\n  return CARD_NUMBERS.map((n) => \"*\".repeat(n.length - 4) + n.slice(-4));\n}\n",
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(top, path)), { recursive: true });
    writeFileSync(join(top, path), text);
  }
  git(top, "init", "-q");
  git(top, "add", "-A");
  git(top, "commit", "-q", "-m", "seed");
  return { top, billing: join(top, "apps/billing") };
}

const context = (stdout: string): string => (stdout.trim() === "" ? "" : (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "");

test("a hook at the repository top answers for the one project nested below it, from the event's cwd or the file it writes", async () => {
  const { top, billing } = monorepo();
  try {
    const start = await runHook("SessionStart", { cwd: top, session_id: "s1" }, top);
    start.commit?.();
    assert.match(context(start.stdout), /adopted in apps\/billing below this folder/, "the start names the project below");
    const edit = await runHook("PreToolUse", { cwd: top, session_id: "s1", tool_name: "Edit", tool_input: { file_path: join(billing, "src/mask.ts"), new_string: "x" } }, top);
    edit.commit?.();
    const orient = context(edit.stdout);
    assert.match(orient, /card numbers masked/, "orient reads the nested project's spec");
    assert.doesNotMatch(orient, /outside door|outside practice/, "and nothing of another team's");
    assert.match(orient, /list before charging \(version/, "an edit inside the project fires its practice, matched against the project's own paths");
    const ls = await runHook("PreToolUse", { cwd: top, session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }, top);
    assert.match(context(ls.stdout), /list before charging/, "a command run at the top fires the nested project's practice");
    assert.doesNotMatch(context(ls.stdout), /outside practice/);
    ls.commit?.();
    assert.ok(existsSync(join(billing, ".coherence")), "the project's records are kept in the project");
    assert.ok(!existsSync(join(top, ".coherence")), "nothing is written at the repository top");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a session at the repository top gets orient once, at its first tool use inside the project, and nothing for work elsewhere", async () => {
  const { top, billing } = monorepo();
  const { countingGit } = await import("../adapters/git-count-fixture.ts");
  try {
    const hook = async (event: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop", input: Record<string, unknown>): Promise<string> => {
      const result = await runHook(event, { cwd: top, session_id: "s1", ...input }, top);
      assert.equal(result.exit, 0, result.stderr);
      result.commit?.();
      return context(result.stdout) || result.stdout;
    };
    const ORIENT = /Coherence vocabulary \(/;
    assert.doesNotMatch(await hook("SessionStart", {}), ORIENT, "the start carries one line, not orient");
    const git = countingGit();
    const elsewhere: string[] = [];
    let calls: string[] = [];
    try {
      for (const input of [
        { prompt: "fix the other team's door" },
        { tool_name: "Edit", tool_input: { file_path: join(top, "libs/other/door.ts"), new_string: "x" } },
        { tool_name: "Bash", tool_input: { command: "ls libs/other" } },
      ]) {
        const event = "prompt" in input ? "UserPromptSubmit" : "PreToolUse";
        elsewhere.push(await hook(event, input));
        if (event === "PreToolUse") elsewhere.push(await hook("PostToolUse", input));
      }
      elsewhere.push(await hook("Stop", {}));
      calls = git.calls();
    } finally {
      git.restore();
    }
    assert.deepEqual(elsewhere, ["", "", "", "", "", ""], "work outside the project, and a prompt and a stop before entering it, hear nothing");
    assert.ok(calls.length <= 6 && calls.every((c) => c.includes("coherence.config.json")), `one listing of where the projects are per event at most: ${calls.join("; ")}`);
    assert.ok(!existsSync(join(billing, ".coherence")) && !existsSync(join(top, ".coherence")), "and nothing is written anywhere");
    const first = await hook("PostToolUse", { tool_name: "Edit", tool_input: { file_path: join(billing, "src/mask.ts") } });
    assert.match(first, ORIENT, "the first tool use inside the project carries orient");
    // The nested project's own: its practice. Its invariant is no longer listed open here, since the edit's own check ran before orient read the spec.
    assert.match(first, /list before charging/);
    const second = await hook("PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(billing, "src/store.ts"), new_string: "x" } });
    assert.doesNotMatch(second, ORIENT, "and only the first");
    assert.doesNotMatch(await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }), ORIENT, "nor a command at the top once the session has entered");
  } finally {
    // An edit inside the project reaches its instrument through a warm server, which outlives the test unless it is stopped.
    await stopWarmServers(top);
    rmSync(top, { recursive: true, force: true });
  }
});

test("an event outside every project is ignored: no answer, nothing written, wherever the session started", async () => {
  const { top } = monorepo();
  try {
    const outside = join(top, "libs/other");
    const events = [
      ["PreToolUse", { cwd: top, session_id: "s1", tool_name: "Edit", tool_input: { file_path: join(outside, "door.ts"), new_string: "x" } }],
      ["PostToolUse", { cwd: top, session_id: "s1", tool_name: "Write", tool_input: { file_path: join(outside, "door.ts"), content: "x" } }],
      ["PreToolUse", { cwd: outside, session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }],
      ["PostToolUse", { cwd: outside, session_id: "s1", tool_name: "Bash", tool_input: { command: "echo x > door.ts" } }],
      ["UserPromptSubmit", { cwd: outside, session_id: "s1", prompt: "hello" }],
      ["Stop", { cwd: outside, session_id: "s1" }],
    ] as const;
    for (const [event, input] of events) {
      const result = await runHook(event, input, top);
      result.commit?.();
      assert.deepEqual({ stdout: result.stdout, stderr: result.stderr, exit: result.exit }, { stdout: "", stderr: "", exit: 0 }, `${event} ${JSON.stringify(input)}`);
    }
    assert.ok(!existsSync(join(top, ".coherence")), "nothing at the top");
    assert.ok(!existsSync(join(top, "apps/billing/.coherence")), "nor in the project, which the events were not about");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("git paths in a nested project are relative to its root and never another folder's", async () => {
  const { top, billing } = monorepo();
  try {
    writeFileSync(join(billing, "src/mask.ts"), "export const changed = 1;\n");
    writeFileSync(join(billing, "src/new.ts"), "export const added = 1;\n");
    writeFileSync(join(top, "libs/other/door.ts"), "export const elsewhere = 1;\n");
    writeFileSync(join(top, "libs/other/added.ts"), "export const elsewhere = 2;\n");
    const want = ["src/mask.ts", "src/new.ts"];
    assert.deepEqual([...(await changedFiles(billing)).files].sort(), want, "the stop's changed files");
    assert.deepEqual(patchFiles(billing), want, "the economy's patch");
    assert.deepEqual(changedSince(billing, git(top, "rev-parse", "HEAD").trim()), want, "query observed --since");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a command run at the repository top acts on the one project nested below it, and on the top when two are", () => {
  const { top, billing } = monorepo();
  try {
    assert.equal(projectRoot(top), billing, "one project below: the command reads and writes its records");
    assert.equal(projectRoot(join(top, "libs/other")), join(top, "libs/other"), "a folder holding no project acts where it stands, as before");
    mkdirSync(join(top, "apps/search"), { recursive: true });
    writeFileSync(join(top, "apps/search/coherence.config.json"), "{}\n");
    assert.equal(projectRoot(join(top, "apps")), join(top, "apps"), "two below: no project is chosen");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("hooks install from a nested project writes the host settings at the repository top and in the project, and its ignore file in the project alone", async () => {
  const { top, billing } = monorepo({ ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2) + "\n" });
  try {
    const cli = (...args: string[]) => inProcess(args, { cwd: billing, env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    const installed = await cli("hooks", "install", "--host", "claude", "--command", "npx coherence");
    assert.equal(installed.status, 0, installed.stderr);
    for (const dir of [top, billing]) {
      const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
      assert.equal(settings.hooks["Stop"]!.at(-1)!.hooks[0]!.command, "npx coherence hook Stop", dir);
    }
    assert.deepEqual((JSON.parse(readFileSync(join(top, ".claude/settings.json"), "utf8")) as { permissions: unknown }).permissions, { allow: ["Bash(ls)"] }, "the adopter's own settings at the top are kept");
    assert.ok(existsSync(join(billing, ".coherence/.gitignore")));
    assert.ok(!existsSync(join(top, ".coherence")), "no .coherence at the top");
    assert.equal((await cli("hooks", "--check", "--host", "claude", "--command", "npx coherence")).status, 0, "both match what install would write");
    assert.equal((await cli("hooks", "uninstall", "--host", "claude")).status, 0);
    for (const dir of [top, billing]) assert.doesNotMatch(readFileSync(join(dir, ".claude/settings.json"), "utf8"), /coherence hook/, `uninstall removes ours from ${dir}`);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("hooks install --local writes the host's personal settings at the repository top alone, and uninstall removes them", async () => {
  const { top, billing } = monorepo();
  try {
    const cli = (...args: string[]) => inProcess(args, { cwd: billing, env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    const shared = readFileSync(join(top, ".claude/settings.json"), "utf8");
    const installed = await cli("hooks", "install", "--host", "claude", "--local", "--command", "npx coherence");
    assert.equal(installed.status, 0, installed.stderr);
    const local = JSON.parse(readFileSync(join(top, ".claude/settings.local.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    assert.equal(local.hooks["Stop"]!.at(-1)!.hooks[0]!.command, "npx coherence hook Stop");
    assert.equal(readFileSync(join(top, ".claude/settings.json"), "utf8"), shared, "the committed settings are untouched");
    assert.ok(!existsSync(join(billing, ".claude")), "nothing in the folder's own settings");
    assert.ok(existsSync(join(billing, ".coherence/.gitignore")), "the ignore file as before");
    assert.equal((await cli("hooks", "--check", "--host", "claude", "--local", "--command", "npx coherence")).status, 0);
    assert.notEqual((await cli("hooks", "install", "--host", "codex", "--local")).status, 0, "a host with no personal settings file is refused");
    assert.equal((await cli("hooks", "uninstall", "--host", "claude")).status, 0);
    assert.doesNotMatch(readFileSync(join(top, ".claude/settings.local.json"), "utf8"), /coherence hook/, "uninstall removes ours from the personal settings too");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a chokepoint verdict over a nested project says its reference search covered that folder alone", { timeout: 120_000 }, async () => {
  const { top, billing } = monorepo();
  const adapter = new TypeScriptAdapter(billing);
  try {
    const result = await checkChokepoint(adapter, { protects: "CARD_NUMBERS", chokepoint: "mask", component: ".", testFolders: [], root: billing });
    assert.equal(result.grade, "reference-choked", result.reason);
    assert.equal(result.horizon, "apps/billing");
    assert.match(result.reason, /references searched inside apps\/billing only: callers elsewhere in the repository were not read$/);
  } finally {
    await adapter.close();
    rmSync(top, { recursive: true, force: true });
  }
});

test("a nested Python project's imports written from the repository top resolve, so a bypass inside the project through one is found", { timeout: 120_000 }, async () => {
  const { PythonAdapter } = await import("../adapters/python.ts");
  const { top } = monorepo({
    "apps/nb/coherence.config.json": JSON.stringify({ name: "nb", language: "python" }) + "\n",
    "apps/nb/query.py": "_KINDS = {\"a\"}\n\n\ndef normalize(q):\n    return q in _KINDS\n",
    "apps/nb/routes.py": "from apps.nb.query import _KINDS\n\n\ndef route():\n    return len(_KINDS)\n",
  });
  const root = join(top, "apps/nb");
  const adapter = new PythonAdapter(root);
  try {
    const result = await checkChokepoint(adapter, { protects: "_KINDS", chokepoint: "normalize", component: ".", testFolders: [], root });
    assert.equal(result.grade, "broken", result.reason);
    assert.deepEqual(result.bypasses.map((b) => `${b.file}:${b.line}`), ["routes.py:1", "routes.py:5"]);
    assert.match(result.reason, /references searched inside apps\/nb only/);
  } finally {
    await adapter.close();
    rmSync(top, { recursive: true, force: true });
  }
});

/** A chokepoint check of the nested project under each reference horizon, with a bypass planted in another team's folder. */
async function underHorizon(language: "typescript" | "python", references: unknown): Promise<{ grade: string; bypasses: string[]; reason: string }> {
  const ts = language === "typescript";
  const { top } = monorepo({
    "apps/nb/coherence.config.json": JSON.stringify({ name: "nb", language, ...(references === undefined ? {} : { references }) }) + "\n",
    ...(ts
      ? {
          "apps/nb/tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowImportingTsExtensions: true, noEmit: true, strict: true }, include: ["**/*.ts"] }) + "\n",
          "apps/nb/query.ts": "export const KINDS = new Set([\"a\"]);\nexport function normalize(q: string): boolean {\n  return KINDS.has(q);\n}\n",
          "libs/leaky/leak.ts": "import { KINDS } from \"../../apps/nb/query.ts\";\nexport const leaked = KINDS.size;\n",
        }
      : {
          "apps/nb/query.py": "KINDS = {\"a\"}\n\n\ndef normalize(q):\n    return q in KINDS\n",
          "libs/leaky/leak.py": "from apps.nb.query import KINDS\n\nleaked = len(KINDS)\n",
        }),
  });
  const root = join(top, "apps/nb");
  const { PythonAdapter } = await import("../adapters/python.ts");
  const adapter = ts ? new TypeScriptAdapter(root) : new PythonAdapter(root);
  try {
    const result = await checkChokepoint(adapter, { protects: "KINDS", chokepoint: "normalize", component: ".", testFolders: [], root });
    return { grade: result.grade, bypasses: result.bypasses.map((b) => `${b.file}:${b.line}`), reason: result.reason };
  } finally {
    await adapter.close();
    rmSync(top, { recursive: true, force: true });
  }
}

test("the reference horizon widens a chokepoint check past the project: a bypass in another folder is found under repository and under a list naming it, and named as not searched under project", { timeout: 240_000 }, async (t) => {
  budget(t, 20, "d-4d6efcf9");
  for (const language of ["typescript", "python"] as const) {
    const leak = language === "typescript" ? "../../libs/leaky/leak.ts:1" : "../../libs/leaky/leak.py:1";
    const project = await underHorizon(language, undefined);
    assert.deepEqual(project.bypasses, [], `${language}: the project alone does not see it`);
    assert.match(project.reason, /references searched inside apps\/nb only: callers elsewhere in the repository were not read$/, `${language}: and says so`);
    const repository = await underHorizon(language, "repository");
    assert.equal(repository.grade, "broken", `${language}: ${repository.reason}`);
    assert.ok(repository.bypasses.includes(leak), `${language}: ${repository.bypasses.join(", ")}`);
    assert.doesNotMatch(repository.reason, /references searched inside/, `${language}: the whole repository was searched, so no qualifier`);
    const listed = await underHorizon(language, ["libs/leaky"]);
    assert.ok(listed.bypasses.includes(leak), `${language}: a list naming the folder finds it: ${listed.reason}`);
    assert.match(listed.reason, /references searched inside apps\/nb and libs\/leaky only/, language);
    const elsewhere = await underHorizon(language, ["libs/other"]);
    assert.deepEqual(elsewhere.bypasses, [], `${language}: a list naming another folder does not`);
    assert.match(elsewhere.reason, /references searched inside apps\/nb and libs\/other only/, language);
  }
});
