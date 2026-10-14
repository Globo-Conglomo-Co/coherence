/**
 * Coherence's Claude Code mod installs per person from Coherence's
 * repository, which is its marketplace, and the mod's own copies of what
 * Coherence declares are generated and held equal here.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WRITERS } from "./host-tools.ts";
import { IGNORE_FILE } from "./install.ts";
import { installMod, localSettingsPath, MARKETPLACE_FILE, MOD_FOLDER, MOD_ID, MOD_REPOSITORY, modInstalled, type ClaudeRunner } from "./mod-install.ts";
import { cli } from "./cli-fixture.ts";

const OWN_PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string): unknown => JSON.parse(readFileSync(join(OWN_PACKAGE, path), "utf8"));

/** What mods/coherence/hooks/writers.ts holds: generated from host-tools.ts. */
export const WRITERS_FILE = `// Generated from src/lifecycle/host-tools.ts (WRITERS.claude); src/lifecycle/mod-install.test.ts holds it equal. Do not edit by hand.\nexport const WRITER_TOOLS: readonly string[] = ${JSON.stringify(Object.keys(WRITERS.claude))}\n`;

test("the repository's marketplace lists the mod at the package's version, and the mod's writer tools are host-tools.ts's", () => {
  const path = join(OWN_PACKAGE, MOD_FOLDER, "hooks", "writers.ts");
  assert.equal(readFileSync(path, "utf8"), WRITERS_FILE, `${path} drifted from host-tools.ts; replace it with:\n${WRITERS_FILE}`);
  const pkg = read("package.json") as { version: string };
  const plugin = read(join(MOD_FOLDER, ".claude-plugin", "plugin.json")) as { name: string; version: string };
  const market = read(MARKETPLACE_FILE) as { name: string; plugins: { name: string; source: string }[] };
  assert.equal(plugin.version, pkg.version, "the mod and the command line it runs are one version");
  assert.equal(`${plugin.name}@${market.name}`, MOD_ID);
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [[plugin.name, `./${MOD_FOLDER}`]]);
});

test("install stops at the first claude plugin step that fails", () => {
  const calls: string[] = [];
  const failing: ClaudeRunner = (args) => (calls.push(args.join(" ")), { status: 1, stdout: '{"message":"no such folder"}', stderr: "" });
  const steps = installMod("/p", failing);
  assert.deepEqual(calls, [`plugin marketplace add ${MOD_REPOSITORY} --scope local --json`]);
  assert.deepEqual(steps.map((s) => [s.ok, s.said]), [[false, "no such folder"]]);
  const absent: ClaudeRunner = () => ({ status: null, stdout: "", stderr: "spawn claude ENOENT" });
  assert.match(installMod("/p", absent)[0]!.said, /claude could not be run \(spawn claude ENOENT\)/);
});

/** A `claude` on the PATH that writes the personal settings as Claude Code's plugin commands do, and logs each call. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, args.join(" ") + "\\n");
const file = args.includes("project") ? ".claude/settings.json" : ".claude/settings.local.json";
let s = {};
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const verb = args.slice(0, args[1] === "marketplace" ? 3 : 2).join(" ");
if (verb === "plugin marketplace add") s.extraKnownMarketplaces = { other: { source: { source: "github", repo: "o/r" } }, coherence: { source: { source: "github", repo: args[3] } } };
else if (verb === "plugin install") s.enabledPlugins = { ...s.enabledPlugins, [args[2]]: true };
else if (verb === "plugin uninstall") delete (s.enabledPlugins ?? {})[args[2]];
fs.mkdirSync(".claude", { recursive: true });
fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\\n");
console.log(JSON.stringify({ outcome: "ok", message: "done: " + verb }));
`;

test("hooks install --mod installs the mod at the personal scope from Coherence's repository, hands it the personal hooks, keeps the team's and names them, and uninstall takes out the mod and its declaration alone", async () => {
  const project = await mkdtemp(join(tmpdir(), "coherence-mod-install-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
    const bin = join(project, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "claude"), FAKE_CLAUDE);
    await chmod(join(bin, "claude"), 0o755);
    const log = join(project, "claude.log");
    const env = { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, FAKE_CLAUDE_LOG: log };
    const hooks = (...args: string[]) => cli(["hooks", ...args], { cwd: project, env });

    assert.equal((await hooks("install", "--host", "claude")).status, 0, "the team's committed hooks");
    assert.equal((await hooks("install", "--host", "claude", "--local")).status, 0, "and this person's");
    assert.equal((await hooks("install", "--host", "codex", "--mod")).status, 64, "the mod is Claude Code's alone");
    assert.equal((await hooks("install", "--host", "claude", "--mod", "--local")).status, 64, "the mod is always personal");

    const installed = await hooks("install", "--host", "claude", "--mod");
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`plugin marketplace add ${MOD_REPOSITORY} --scope local --json`, `plugin install ${MOD_ID} --scope local --json`]);
    const local = JSON.parse(await readFile(join(project, ".claude", "settings.local.json"), "utf8")) as Record<string, unknown>;
    assert.equal(local["hooks"], undefined, "the personal settings hooks leave: the mod would stand aside for each");
    assert.equal(modInstalled(project), true);
    assert.match(installed.stdout, /settings\.json still runs Coherence for SessionStart.*the mod answers none of those events while it does/, "the team's hooks are kept and named");
    assert.match((await hooks("--check", "--host", "claude", "--local")).stdout, new RegExp(`${MOD_ID} is enabled in the personal settings and answers every event`));
    assert.match((await hooks("status")).stdout, new RegExp(`${MOD_ID} enabled in the personal settings`));

    // The committed hooks leave; .coherence's own files stay while the mod still runs Coherence.
    await writeFile(log, "");
    assert.equal((await hooks("uninstall", "--host", "claude")).status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`plugin uninstall ${MOD_ID} --scope local --json`], "the mod leaves first, and the marketplace is never removed: that would uninstall the mod from every project on the machine");
    assert.equal(modInstalled(project), false);
    const after = JSON.parse(await readFile(join(project, ".claude", "settings.local.json"), "utf8")) as { extraKnownMarketplaces?: Record<string, unknown> };
    assert.deepEqual(Object.keys(after.extraKnownMarketplaces ?? {}), ["other"], "only the declaration install wrote leaves");
    assert.equal(existsSync(join(project, IGNORE_FILE)), false, "with nothing left running Coherence, the ignore file goes as before");

    // Claude Code's local scope in a git worktree is the main checkout's file: the mod is read, and its declaration dropped, there.
    const git = (...args: string[]) => assert.equal(spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: project }).status, 0, args.join(" "));
    git("commit", "-q", "--allow-empty", "-m", "start");
    const tree = join(project, "tree");
    git("worktree", "add", "-q", tree);
    assert.equal(localSettingsPath(tree), join(realpathSync(project), ".claude", "settings.local.json"));
    await writeFile(join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { [MOD_ID]: true } }));
    assert.equal(modInstalled(tree), true, "enabled in the main checkout is enabled in its worktree");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("while the mod is the only thing running Coherence, removing the last settings hook keeps .coherence's own files", async () => {
  const project = await mkdtemp(join(tmpdir(), "coherence-mod-keeps-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
    assert.equal((await cli(["hooks", "install", "--host", "claude"], { cwd: project })).status, 0);
    await writeFile(join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { [MOD_ID]: true } }));
    const { uninstall } = await import("./install.ts");
    const result = await uninstall(project, "claude");
    assert.equal(result.removedIgnore, false);
    assert.ok(existsSync(join(project, IGNORE_FILE)));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("hooks install --mod --shared enables the mod in the committed settings in place of the committed Claude Code hooks, keeps the other host's, and uninstall takes it out", async () => {
  const project = await mkdtemp(join(tmpdir(), "coherence-mod-shared-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
    const bin = join(project, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "claude"), FAKE_CLAUDE);
    await chmod(join(bin, "claude"), 0o755);
    const log = join(project, "claude.log");
    const env = { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, FAKE_CLAUDE_LOG: log };
    const hooks = (...args: string[]) => cli(["hooks", ...args], { cwd: project, env });

    assert.equal((await hooks("install", "--host", "claude")).status, 0);
    assert.equal((await hooks("install", "--host", "codex")).status, 0);
    assert.equal((await hooks("install", "--host", "claude", "--shared")).status, 64, "--shared belongs to --mod");
    const installed = await hooks("install", "--host", "claude", "--mod", "--shared");
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`plugin marketplace add ${MOD_REPOSITORY} --scope project --json`, `plugin install ${MOD_ID} --scope project --json`]);
    const committed = JSON.parse(await readFile(join(project, ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(committed["hooks"], undefined, "the committed Claude Code hooks leave: the mod would stand aside for each");
    assert.equal(modInstalled(project, "project"), true);
    assert.ok(existsSync(join(project, ".codex", "hooks.json")) && readFileSync(join(project, ".codex", "hooks.json"), "utf8").includes("hook Stop"), "Codex keeps its hooks");
    assert.ok(existsSync(join(project, IGNORE_FILE)), ".coherence's own files stay");
    const check = await hooks("--check", "--host", "claude");
    assert.equal(check.status, 0, check.stdout);
    assert.match(check.stdout, new RegExp(`${MOD_ID} is enabled in the committed settings and answers every event`));
    assert.match((await hooks("status")).stdout, new RegExp(`${MOD_ID} enabled in the committed settings`));

    await writeFile(log, "");
    assert.equal((await hooks("uninstall", "--host", "claude")).status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`plugin uninstall ${MOD_ID} --scope project --json`]);
    assert.equal(modInstalled(project, "project"), false);
    const after = JSON.parse(await readFile(join(project, ".claude", "settings.json"), "utf8")) as { extraKnownMarketplaces?: Record<string, unknown> };
    assert.deepEqual(Object.keys(after.extraKnownMarketplaces ?? {}), ["other"], "only the declaration install wrote leaves");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
