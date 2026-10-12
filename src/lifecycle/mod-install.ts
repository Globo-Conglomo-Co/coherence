/**
 * Coherence's Claude Code mod, enabled for one person in one project.
 *
 * The mod (mods/coherence) answers Claude Code's hook events through one warm
 * process per session instead of a settings hook per event. Coherence's
 * repository is its marketplace (.claude-plugin/marketplace.json, one entry,
 * the mod's folder), and the mod runs the project's own installed Coherence,
 * so it is a forwarder that any project's version can sit behind: an event
 * the warm process cannot answer runs through `coherence hook` as a settings
 * hook would.
 *
 * Install is Claude Code's own: `claude plugin marketplace add
 * PostHog/coherence --scope local` and `claude plugin install
 * coherence@coherence --scope local`, which write the project's personal
 * settings (.claude/settings.local.json, never committed). The marketplace is
 * the repository, never a project's node_modules folder: Claude Code knows a
 * marketplace by its name on the whole machine, so a second project
 * registering its own folder would repoint the first project's mod at it.
 * Enabling is personal because the fast path is opt-in: teammates keep the
 * committed settings hooks until they choose the mod.
 *
 * The mod stands aside for every event whose settings hooks already run
 * Coherence, so install removes Coherence's hooks from the personal settings
 * and leaves the committed ones, which belong to the team, and says while
 * they remain that the mod answers no event they cover.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "./work-meter.ts";
import { LOCAL_SETTINGS_FILE } from "./project.ts";

export const MOD_NAME = "coherence";
export const MOD_MARKETPLACE = "coherence";
export const MOD_ID = `${MOD_NAME}@${MOD_MARKETPLACE}`;
/** The marketplace: Coherence's repository, as `claude plugin marketplace add` takes it. */
export const MOD_REPOSITORY = "PostHog/coherence";
/** Where the mod sits in the repository, and the marketplace file that lists it, both relative to its root. */
export const MOD_FOLDER = join("mods", MOD_NAME);
export const MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");

/** Runs `claude` with these arguments; injected so tests run none. */
export type ClaudeRunner = (args: readonly string[], cwd: string) => { status: number | null; stdout: string; stderr: string };

export const runClaude: ClaudeRunner = (args, cwd) => {
  const ran = spawnSync("claude", [...args], { cwd, encoding: "utf8" });
  return { status: ran.error === undefined ? ran.status : null, stdout: ran.stdout ?? "", stderr: ran.error === undefined ? (ran.stderr ?? "") : ran.error.message };
};

/**
 * The personal settings file Claude Code's local scope writes for a folder:
 * the main checkout's, also for a folder in one of its git worktrees, since
 * Claude Code knows a project by its repository. So enabling the mod in a
 * worktree enables it in the main checkout and every worktree of it.
 */
export function localSettingsPath(root: string): string {
  const common = spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  const dir = common.status === 0 ? common.stdout.trim() : "";
  return join(basename(dir) === ".git" ? dirname(dir) : root, LOCAL_SETTINGS_FILE.claude!);
}

/** Whether the personal settings Claude Code reads for this folder enable the mod. */
export function modInstalled(root: string): boolean {
  try {
    const settings = JSON.parse(readFileSync(localSettingsPath(root), "utf8")) as { enabledPlugins?: Record<string, unknown> };
    return settings.enabledPlugins?.[MOD_ID] === true;
  } catch {
    return false;
  }
}

export interface ModStep {
  args: string[];
  ok: boolean;
  said: string;
}

/** What a `claude plugin` call said: its last JSON line's message, else its output. */
function said(out: { stdout: string; stderr: string }): string {
  const last = out.stdout.trim().split("\n").at(-1) ?? "";
  try {
    const message = (JSON.parse(last) as { message?: unknown }).message;
    if (typeof message === "string") return message.trim().split("\n").at(-1) ?? "";
  } catch {
    // Not JSON: the text itself.
  }
  return (out.stderr.trim() || out.stdout.trim()).split("\n").at(-1) ?? "";
}

function step(run: ClaudeRunner, root: string, args: string[]): ModStep {
  const out = run(args, root);
  return { args, ok: out.status === 0, said: out.status === null ? `claude could not be run (${out.stderr || "not on the PATH"})` : said(out) };
}

/** Register Coherence's repository as a marketplace and install the mod, both at the personal scope; stops at the first step that fails. */
export function installMod(root: string, run: ClaudeRunner = runClaude): ModStep[] {
  const steps = [step(run, root, ["plugin", "marketplace", "add", MOD_REPOSITORY, "--scope", "local", "--json"])];
  if (steps[0]!.ok) steps.push(step(run, root, ["plugin", "install", MOD_ID, "--scope", "local", "--json"]));
  return steps;
}

/**
 * Uninstall the mod from the personal scope, then drop the marketplace's
 * declaration that install wrote there, by editing the file: `claude plugin
 * marketplace remove` would uninstall the mod from every project on the
 * machine, since Claude Code knows the marketplace machine-wide.
 */
export function uninstallMod(root: string, run: ClaudeRunner = runClaude): ModStep[] {
  const steps = [step(run, root, ["plugin", "uninstall", MOD_ID, "--scope", "local", "--json"])];
  if (steps[0]!.ok && dropDeclaration(root)) steps.push({ args: ["marketplace declaration", MOD_MARKETPLACE], ok: true, said: `removed from ${localSettingsPath(root)}; other projects keep the marketplace` });
  return steps;
}

/** Remove the personal settings' declaration of Coherence's marketplace, only when it names Coherence's repository; keeps the file's indentation. */
function dropDeclaration(root: string): boolean {
  const path = localSettingsPath(root);
  let text: string;
  let settings: { extraKnownMarketplaces?: Record<string, { source?: { source?: unknown; repo?: unknown } }> };
  try {
    text = readFileSync(path, "utf8");
    settings = JSON.parse(text) as typeof settings;
  } catch {
    return false;
  }
  const declared = settings.extraKnownMarketplaces?.[MOD_MARKETPLACE]?.source;
  if (declared?.source !== "github" || declared.repo !== MOD_REPOSITORY) return false;
  delete settings.extraKnownMarketplaces![MOD_MARKETPLACE];
  if (Object.keys(settings.extraKnownMarketplaces!).length === 0) delete settings.extraKnownMarketplaces;
  const indent = /^[ \t]+/m.exec(text)?.[0] ?? "  ";
  writeFileSync(path, JSON.stringify(settings, null, indent) + (text.endsWith("\n") ? "\n" : ""));
  return true;
}
