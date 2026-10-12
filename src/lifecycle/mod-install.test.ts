/**
 * Coherence's Claude Code mod ships in the package and installs per person:
 * the package root is the marketplace, Claude Code reads the mod from the
 * project's node_modules entry for it, and the mod's own copies of what
 * Coherence declares are generated and held equal here.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WRITERS } from "./host-tools.ts";
import { IGNORE_FILE } from "./install.ts";
import { installMod, MARKETPLACE_FILE, MOD_FOLDER, MOD_ID, modInstalled, modSource, OWN_PACKAGE, type ClaudeRunner } from "./mod-install.ts";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
const read = (path: string): unknown => JSON.parse(readFileSync(join(OWN_PACKAGE, path), "utf8"));

/** What mods/coherence/hooks/writers.ts holds: generated from host-tools.ts. */
export const WRITERS_FILE = `// Generated from src/lifecycle/host-tools.ts (WRITERS.claude); src/lifecycle/mod-install.test.ts holds it equal. Do not edit by hand.\nexport const WRITER_TOOLS: readonly string[] = ${JSON.stringify(Object.keys(WRITERS.claude))}\n`;

test("the mod ships in the package at its version, listed by the package's marketplace, and its writer tools are host-tools.ts's", () => {
  const path = join(OWN_PACKAGE, MOD_FOLDER, "hooks", "writers.ts");
  assert.equal(readFileSync(path, "utf8"), WRITERS_FILE, `${path} drifted from host-tools.ts; replace it with:\n${WRITERS_FILE}`);
  const pkg = read("package.json") as { version: string; files: string[] };
  const plugin = read(join(MOD_FOLDER, ".claude-plugin", "plugin.json")) as { name: string; version: string };
  const market = read(MARKETPLACE_FILE) as { name: string; plugins: { name: string; source: string }[] };
  assert.equal(plugin.version, pkg.version, "the mod and the command line it runs are one version");
  assert.equal(`${plugin.name}@${market.name}`, MOD_ID);
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [[plugin.name, `./${MOD_FOLDER}`]]);
  for (const shipped of [MARKETPLACE_FILE, join(MOD_FOLDER, ".claude-plugin", "plugin.json"), join(MOD_FOLDER, "hooks"), join(MOD_FOLDER, "types")]) assert.ok(pkg.files.includes(shipped), `package.json files ships ${shipped}`);
});

test("hooks install --mod registers the project's node_modules entry, unresolved, else this installation", async () => {
  const project = await mkdtemp(join(tmpdir(), "coherence-mod-source-"));
  try {
    assert.equal(modSource(project), OWN_PACKAGE, "no install in the project: this installation");
    const entry = join(project, "node_modules", "@posthog", "coherence");
    await mkdir(dirname(entry), { recursive: true });
    await symlink(OWN_PACKAGE, entry);
    assert.equal(modSource(project), entry, "the link, not its target, so an upgrade that moves the target is followed");
    assert.equal(modSource(project, project), entry);
    const bare = await mkdtemp(join(tmpdir(), "coherence-mod-none-"));
    assert.equal(modSource(bare, bare), undefined, "a package without the mod offers none");
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("install stops at the first claude plugin step that fails", () => {
  const calls: string[] = [];
  const failing: ClaudeRunner = (args) => (calls.push(args.join(" ")), { status: 1, stdout: '{"message":"no such folder"}', stderr: "" });
  const steps = installMod("/p", "/src", failing);
  assert.deepEqual(calls, ["plugin marketplace add /src --scope local --json"]);
  assert.deepEqual(steps.map((s) => [s.ok, s.said]), [[false, "no such folder"]]);
  const absent: ClaudeRunner = () => ({ status: null, stdout: "", stderr: "spawn claude ENOENT" });
  assert.match(installMod("/p", "/src", absent)[0]!.said, /claude could not be run \(spawn claude ENOENT\)/);
});

/** A `claude` on the PATH that writes the personal settings as Claude Code's plugin commands do, and logs each call. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, args.join(" ") + "\\n");
const file = ".claude/settings.local.json";
let s = {};
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const verb = args.slice(0, args[1] === "marketplace" ? 3 : 2).join(" ");
if (verb === "plugin marketplace add") s.extraKnownMarketplaces = { coherence: { source: { source: "directory", path: args[3] } } };
else if (verb === "plugin install") s.enabledPlugins = { ...s.enabledPlugins, [args[2]]: true };
else if (verb === "plugin uninstall") delete (s.enabledPlugins ?? {})[args[2]];
else if (verb === "plugin marketplace remove") delete (s.extraKnownMarketplaces ?? {})[args[3]];
fs.mkdirSync(".claude", { recursive: true });
fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\\n");
console.log(JSON.stringify({ outcome: "ok", message: "done: " + verb }));
`;

test("hooks install --mod installs the mod at the personal scope from the package, hands it the personal hooks, keeps the team's and names them, and uninstall takes it out first", async () => {
  const project = await mkdtemp(join(tmpdir(), "coherence-mod-install-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
    const bin = join(project, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "claude"), FAKE_CLAUDE);
    await chmod(join(bin, "claude"), 0o755);
    const log = join(project, "claude.log");
    const env = { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, FAKE_CLAUDE_LOG: log };
    const hooks = (...args: string[]) => spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, "hooks", ...args], { cwd: project, encoding: "utf8", env });

    assert.equal(hooks("install", "--host", "claude").status, 0, "the team's committed hooks");
    assert.equal(hooks("install", "--host", "claude", "--local").status, 0, "and this person's");
    assert.equal(hooks("install", "--host", "codex", "--mod").status, 64, "the mod is Claude Code's alone");
    assert.equal(hooks("install", "--host", "claude", "--mod", "--local").status, 64, "the mod is always personal");

    const installed = hooks("install", "--host", "claude", "--mod");
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`plugin marketplace add ${OWN_PACKAGE} --scope local --json`, `plugin install ${MOD_ID} --scope local --json`]);
    const local = JSON.parse(await readFile(join(project, ".claude", "settings.local.json"), "utf8")) as Record<string, unknown>;
    assert.equal(local["hooks"], undefined, "the personal settings hooks leave: the mod would stand aside for each");
    assert.deepEqual(modInstalled(project), { enabled: true, source: OWN_PACKAGE });
    assert.match(installed.stdout, /settings\.json still runs Coherence for SessionStart.*the mod answers none of those events while it does/, "the team's hooks are kept and named");
    assert.match(hooks("--check", "--host", "claude", "--local").stdout, new RegExp(`${MOD_ID} answers every event, read from`));
    assert.match(hooks("status").stdout, new RegExp(`${MOD_ID} enabled in the personal settings`));

    // The committed hooks leave; .coherence's own files stay while the mod still runs Coherence.
    await writeFile(log, "");
    assert.equal(hooks("uninstall", "--host", "claude").status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`plugin uninstall ${MOD_ID} --scope local --json`, `plugin marketplace remove coherence --scope local --json`], "the mod leaves first");
    assert.equal(modInstalled(project).enabled, false);
    assert.equal(existsSync(join(project, IGNORE_FILE)), false, "with nothing left running Coherence, the ignore file goes as before");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("while the mod is the only thing running Coherence, removing the last settings hook keeps .coherence's own files", async () => {
  const project = await mkdtemp(join(tmpdir(), "coherence-mod-keeps-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
    const cli = (...args: string[]) => spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, "hooks", ...args], { cwd: project, encoding: "utf8" });
    assert.equal(cli("install", "--host", "claude").status, 0);
    await writeFile(join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { [MOD_ID]: true } }));
    const { uninstall } = await import("./install.ts");
    const result = await uninstall(project, "claude");
    assert.equal(result.removedIgnore, false);
    assert.ok(existsSync(join(project, IGNORE_FILE)));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
