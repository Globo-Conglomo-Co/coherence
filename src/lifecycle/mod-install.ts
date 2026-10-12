/**
 * Coherence's Claude Code mod, installed for one person on one machine.
 *
 * The mod (mods/coherence) answers Claude Code's hook events through one warm
 * process per session instead of a settings hook per event. It ships in the
 * package, and the package root is a plugin marketplace whose one entry is a
 * relative path to it, so Claude Code reads the mod from the installed
 * package's own folder: upgrading the package upgrades the mod, and the mod
 * and the command line it runs are always one version.
 *
 * Install is Claude Code's own: `claude plugin marketplace add <package>
 * --scope local` and `claude plugin install coherence@coherence --scope
 * local`, which write the project's personal settings
 * (.claude/settings.local.json, never committed). The path is the project's
 * node_modules entry for the package, never its resolved target, so a pnpm
 * upgrade that moves the target is followed. It is per machine because the
 * path is absolute and because the fast path is opt-in: teammates keep the
 * committed settings hooks until they choose the mod.
 *
 * The mod stands aside for every event whose settings hooks already run
 * Coherence, so install removes Coherence's hooks from the personal settings
 * and leaves the committed ones, which belong to the team, and says while
 * they remain that the mod answers no event they cover.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "./work-meter.ts";
import { LOCAL_SETTINGS_FILE, PACKAGE_NAME } from "./project.ts";

export const MOD_NAME = "coherence";
export const MOD_MARKETPLACE = "coherence";
export const MOD_ID = `${MOD_NAME}@${MOD_MARKETPLACE}`;
/** Where the mod sits in the package, and the marketplace file that lists it, both relative to the package root. */
export const MOD_FOLDER = join("mods", MOD_NAME);
export const MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");

/** This installation's package root: the folder two up from this module, in a checkout and in the published package alike. */
export const OWN_PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Runs `claude` with these arguments; injected so tests run none. */
export type ClaudeRunner = (args: readonly string[], cwd: string) => { status: number | null; stdout: string; stderr: string };

export const runClaude: ClaudeRunner = (args, cwd) => {
  const ran = spawnSync("claude", [...args], { cwd, encoding: "utf8" });
  return { status: ran.error === undefined ? ran.status : null, stdout: ran.stdout ?? "", stderr: ran.error === undefined ? (ran.stderr ?? "") : ran.error.message };
};

/**
 * The marketplace folder to register: the project's node_modules entry for
 * the package when it holds the marketplace (unresolved, so an upgrade that
 * moves its target is followed), else this installation's own root (a
 * checkout COHERENCE_HOME names, or a package found elsewhere).
 */
export function modSource(root: string, own = OWN_PACKAGE): string | undefined {
  const installed = join(root, "node_modules", ...PACKAGE_NAME.split("/"));
  for (const dir of [installed, own]) if (existsSync(join(dir, MARKETPLACE_FILE)) && existsSync(join(dir, MOD_FOLDER, ".claude-plugin", "plugin.json"))) return dir;
  return undefined;
}

/** Whether the project's personal settings enable the mod, and the marketplace folder they name for it. */
export function modInstalled(root: string): { enabled: boolean; source?: string } {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(join(root, LOCAL_SETTINGS_FILE.claude!), "utf8")) as Record<string, unknown>;
  } catch {
    return { enabled: false };
  }
  const enabled = (settings["enabledPlugins"] as Record<string, unknown> | undefined)?.[MOD_ID] === true;
  const source = ((settings["extraKnownMarketplaces"] as Record<string, { source?: { path?: unknown } }> | undefined)?.[MOD_MARKETPLACE]?.source?.path);
  return typeof source === "string" ? { enabled, source } : { enabled };
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
    if (typeof message === "string") return message;
  } catch {
    // Not JSON: the text itself.
  }
  return (out.stderr.trim() || out.stdout.trim()).split("\n").at(-1) ?? "";
}

function step(run: ClaudeRunner, root: string, args: string[]): ModStep {
  const out = run(args, root);
  return { args, ok: out.status === 0, said: out.status === null ? `claude could not be run (${out.stderr || "not on the PATH"})` : said(out) };
}

/** Register the package's marketplace and install the mod, both at the personal scope; stops at the first step that fails. */
export function installMod(root: string, source: string, run: ClaudeRunner = runClaude): ModStep[] {
  const steps = [step(run, root, ["plugin", "marketplace", "add", source, "--scope", "local", "--json"])];
  if (steps[0]!.ok) steps.push(step(run, root, ["plugin", "install", MOD_ID, "--scope", "local", "--json"]));
  return steps;
}

/** Uninstall the mod and remove its marketplace from the personal settings; both run, whatever the first said. */
export function uninstallMod(root: string, run: ClaudeRunner = runClaude): ModStep[] {
  return [step(run, root, ["plugin", "uninstall", MOD_ID, "--scope", "local", "--json"]), step(run, root, ["plugin", "marketplace", "remove", MOD_MARKETPLACE, "--scope", "local", "--json"])];
}
