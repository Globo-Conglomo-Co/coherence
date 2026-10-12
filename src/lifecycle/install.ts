/**
 * Hook wiring for a host, written into the project and never over anyone
 * else's hooks.
 *
 * Claude Code reads `.claude/settings.json`; Codex reads `.codex/hooks.json`.
 * Both use the same shape: `hooks -> EventName -> [{ matcher?, hooks: [{ type:
 * "command", command, timeout }] }]` (Claude Code: https://code.claude.com/docs/en/hooks;
 * Codex: https://learn.chatgpt.com/docs/hooks). Install merges: an existing
 * entry for another command is kept; a command Coherence wrote earlier is
 * replaced, and only a command that names this tool's binary or its own cli
 * path counts as Coherence's; everything outside `hooks` is untouched. No
 * hook that is not ours is ever deleted.
 *
 * Uninstall is the same ownership rule run the other way: every command that
 * is ours leaves, and an entry, an event list, or a `hooks` object that this
 * removal emptied goes with it; everything else stays where it was. The check
 * compares what is installed with what install would write, event by event,
 * and names each drift: missing, stale, or an extra entry of ours. Install
 * and uninstall keep the file's indentation and final newline and write
 * nothing when nothing changed, so a round trip gives back the adopter's file.
 *
 * An adopter's hook finds Coherence rather than naming one path to it:
 * Coherence is the package the project installed as a dev dependency (never
 * a checkout `npm link`ed in: that installed a second dependency tree and
 * broke a pnpm build). The command walks up to the project root and runs
 * exactly one of two things: the checkout $COHERENCE_HOME names, which a
 * developer of Coherence sets in the agent host's environment, or else the
 * installed package's own cli (the project's node_modules/.bin/coherence
 * when the package's cli is not where npm puts it). A hook an earlier
 * Coherence wrote also looked in a `coherence` folder beside the project,
 * before the installed package; it is named by the check and at every
 * session start with the command that reinstalls it. Coherence's own
 * repository runs its own source instead, in its main checkout and in each
 * of its worktrees. The committed command names no one's absolute
 * path, so it is the same on every teammate's machine and the check agrees
 * across them. When nothing is found, or node is not on the PATH, the hook
 * prints one line as a systemMessage (both hosts show it to the user), exits
 * 0, and does nothing else.
 *
 * Install also writes `.coherence/.gitignore` once, so an adopter's git sees
 * only what Coherence keeps for good (the journal, runs and work orders, and
 * the project's own hook voice) and none of the state it regenerates. The
 * file sits inside Coherence's own folder, so install edits nothing the
 * adopter wrote; a file there with any other text is the adopter's and is
 * left alone. Install writes `.coherence/.gitattributes` too, so two
 * branches' records merge without a conflict (state-files.ts). Uninstall
 * removes each only when it is still exactly what Coherence wrote and no
 * agent host keeps a hook of ours.
 */

import { spawnSync } from "./work-meter.ts";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { HOOK_EVENTS, type HookEvent } from "./hook.ts";
import { DURABLE_FOLDERS, HOME_VAR, HOSTS, LOCAL_SETTINGS_FILE, PACKAGE_NAME, SETTINGS_FILE, SIBLING, isHost, type Host } from "./project.ts";
import { nestedFolder, repositoryTop } from "../adapters/project-files.ts";
import { registryOf } from "../adapters/project-config.ts";
import { EARLIER_SEARCH, earlierMatcher, searchesCheckoutFirst } from "./version.ts";
import { modInstalled } from "./mod-install.ts";
import { isOwnHook } from "./hook-command.ts";
import { CLAUDE_WRITER_MATCHER, writersUnmatched } from "./host-tools.ts";
import { ATTRIBUTES_FILE, ATTRIBUTES_TEXT, IGNORE_FILE, IGNORE_TEXT, STATE_DIR, keepAttributes, keepIgnore, removeStateFiles, type AttributesAction, type IgnoreAction } from "./state-files.ts";
export { DURABLE_FOLDERS, HOME_VAR, SIBLING };
export { EARLIER_SEARCH, earlierHookLines, searchesCheckoutFirst } from "./version.ts";

// Where each host keeps its settings, and which hosts there are, live in the project
// layer: the hook reads them to know which tree it was installed for.
export { HOSTS, LOCAL_SETTINGS_FILE, SETTINGS_FILE, isHost, type Host };

/** The settings file install writes for a host: the shared one, or with `local` the host's personal one (undefined for a host that has none). */
export function settingsFile(host: Host, local = false): string | undefined {
  return local ? LOCAL_SETTINGS_FILE[host] : SETTINGS_FILE[host];
}

/** How long a hook may run, in seconds. The check reads every changed file once. */
const TIMEOUT_SECONDS = 60;

/**
 * Codex spills a start hook's context over 2,500 tokens by default; the
 * injection is held under 9,500 characters, and this keeps a stricter
 * tokenizer from spilling it anyway.
 */
const CODEX_CONTEXT_LIMIT = 4000;

/** The events whose output is context for the model rather than a verdict. */
const START_EVENTS: ReadonlySet<string> = new Set(["SessionStart", "SubagentStart"]);

/**
 * A command is Coherence's when the program it runs is this tool's binary
 * (`coherence`, bare, at the end of a path such as node_modules/.bin, or the
 * `$coherence` the located command runs) or this tool's own cli path
 * (`src/cli.ts`, as Coherence's own checkout wires it), followed by `hook
 * <Event>`. A stranger's cli.ts, or a program whose name merely contains
 * "coherence", is never ours and is never touched.
 */
function isMine(command: unknown): command is string {
  return typeof command === "string" && HOOK_EVENTS.some((event) => isOwnHook(command, event));
}

interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
  [key: string]: unknown;
}

type HooksByEvent = Record<string, HookEntry[]>;

export interface InstallOptions {
  root: string;
  host: Host;
  /** The command prefix that reaches this CLI, e.g. "npx coherence" or "node src/cli.ts". */
  command: string;
}

/** Walk up from the host's project dir (or cwd) to the folder that holds a host's settings. */
const ROOT_WALK =
  'root="${CLAUDE_PROJECT_DIR:-$PWD}"; while [ "$root" != / ] && [ ! -f "$root/.claude/settings.json" ] && [ ! -f "$root/.codex/hooks.json" ]; do root=$(dirname "$root"); done';

/** The same walk for hooks kept in the personal settings, which stops at a folder holding either file. */
const LOCAL_ROOT_WALK =
  'root="${CLAUDE_PROJECT_DIR:-$PWD}"; while [ "$root" != / ] && [ ! -f "$root/.claude/settings.json" ] && [ ! -f "$root/.claude/settings.local.json" ] && [ ! -f "$root/.codex/hooks.json" ]; do root=$(dirname "$root"); done';

/**
 * Shell that sets `$coherence` to the cli to run, or to nothing: the
 * checkout $COHERENCE_HOME names, else the installed package's own cli, else
 * the project's own bin. No folder that merely sits beside the project is
 * ever run: an adopter's stale clone at ../coherence once answered every
 * session while the installed release was current. The package's cli comes
 * before the bin because a package manager may write the bin as a shell shim
 * that node cannot run. Nothing here names a path on one machine. Settings
 * at a repository's top for a project nested below it (`sub`, the project's
 * folder from the top) look in that project's own node_modules first, where
 * the project installed Coherence.
 */
export function locateShell(sub = "", local = false): string {
  const quoted = sub.replace(/["$`\\]/g, "\\$&");
  const own = sub === "" ? "" : `"$root/${quoted}/node_modules/${PACKAGE_NAME}/dist/cli.js" "$root/${quoted}/node_modules/.bin/coherence" `;
  return [
    local ? LOCAL_ROOT_WALK : ROOT_WALK,
    "coherence=",
    `for c in "\${${HOME_VAR}:+\$${HOME_VAR}/src/cli.ts}" ${own}"$root/node_modules/${PACKAGE_NAME}/dist/cli.js" "$root/node_modules/.bin/coherence"; do if [ -n "$c" ] && [ -f "$c" ]; then coherence=$c; break; fi; done`,
  ].join("; ");
}

export const LOCATE = locateShell();

/** The one line the user is shown at session start when Coherence cannot be reached. No apostrophes: it sits in single quotes. */
export const NOT_INSTALLED = "Coherence is configured for this project but not installed, so its hooks do nothing this session; the agent has been told how to install it.";

/**
 * What the agent is told at session start when Coherence cannot be reached:
 * that it is missing, every way to supply it, and that changing the
 * project's dependencies is the user's decision. The agent makes the call.
 * No apostrophes: it sits in single quotes.
 */
export const MISSING_CONTEXT = `Coherence is configured for this project (its hooks are in the agent host settings) but is not installed, so they do nothing this session: no vocabulary, specs, journal or checks. If package.json already lists ${PACKAGE_NAME}, the project install has not run here: run it with the package manager this project uses (npm ci, pnpm install, yarn install). Otherwise add it as a dev dependency (npm install -D ${PACKAGE_NAME}, pnpm add -D ${PACKAGE_NAME}, or yarn add -D ${PACKAGE_NAME}), which changes package.json and the lockfile. Changing the project dependencies is for the user to decide: unless the user asked for Coherence in this session, tell them it is missing and ask before installing it. Once it is installed, npx --no -- coherence spec --check confirms it, and the hooks answer from their next event.`;

/** The one line the user is shown at session start when Coherence is there but node is not. */
export const NO_NODE = "Coherence was found but node is not on the PATH its hooks run with, so they do nothing this session. Install Node 22.18 or newer.";

/** Shell that prints `output` as JSON when the event, the function's second argument, is SessionStart, and nothing otherwise, then exits 0. */
function atSessionStart(output: object): string {
  return `if [ "$2" = SessionStart ]; then printf '%s\\n' '${JSON.stringify(output)}'; fi; exit 0`;
}

/**
 * The default prefix for an adopter: locate Coherence, and otherwise run it
 * as before (`hook <Event>` follows, the arguments of the shell function
 * named for it), so a found Coherence answers, and refuses, exactly as a
 * direct command would. Where it is not found, or node is not, every event
 * exits 0 in silence but the session start, which tells the user in one line
 * and, when Coherence is missing, tells the agent how to supply it.
 */
export function locatedPrefix(sub = "", local = false): string {
  return `${locateShell(sub, local)}; coherence() { if [ -z "$coherence" ]; then ${atSessionStart({ systemMessage: NOT_INSTALLED, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: MISSING_CONTEXT } })}; fi; if ! command -v node >/dev/null 2>&1; then ${atSessionStart({ systemMessage: NO_NODE })}; fi; exec node "$coherence" "$@"; }; coherence`;
}

export const LOCATED_PREFIX = locatedPrefix();

/** Where the located command would find Coherence from `root`, under `env`; undefined when it would find nothing. */
export function locate(root: string, env: NodeJS.ProcessEnv = process.env, sub = ""): string | undefined {
  const run = spawnSync("sh", ["-c", `${locateShell(sub)}; printf '%s' "$coherence"`], { cwd: root, env: { ...env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8" });
  const found = run.status === 0 ? run.stdout : "";
  return found === "" ? undefined : found;
}

export function hookCommand(prefix: string, event: HookEvent): string {
  return `${prefix} hook ${event}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCoherenceEntry(entry: unknown): entry is HookEntry {
  return (
    isRecord(entry) &&
    Array.isArray(entry["hooks"]) &&
    entry["hooks"].some((h) => isRecord(h) && isMine(h["command"]))
  );
}

/** A settings file as read: its value, and the layout a rewrite keeps. */
interface SettingsFile {
  exists: boolean;
  value: Record<string, unknown>;
  indent: string | number;
  trailingNewline: boolean;
}

/** The indentation of the first indented key, or two spaces for a file that has none. */
function indentationOf(text: string): string | number {
  return text.match(/^([\t ]+)"/m)?.[1] ?? 2;
}

async function readSettingsFile(path: string): Promise<SettingsFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { exists: false, value: {}, indent: 2, trailingNewline: true };
  }
  const layout = { exists: true, indent: indentationOf(text), trailingNewline: text === "" || text.endsWith("\n") };
  if (text.trim() === "") return { ...layout, value: {} };
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`${path}: expected a JSON object`);
  return { ...layout, value: parsed };
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  return (await readSettingsFile(path)).value;
}

/** Write `value` in the file's own layout, and only when it differs from what is there. */
async function writeSettings(path: string, file: SettingsFile, value: Record<string, unknown>): Promise<boolean> {
  if (file.exists && isDeepStrictEqual(file.value, value)) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, file.indent) + (file.trailingNewline ? "\n" : ""));
  return true;
}

function hooksOf(settings: Record<string, unknown>): HooksByEvent {
  const hooks = settings["hooks"];
  if (hooks === undefined) return {};
  if (!isRecord(hooks)) throw new Error("settings.hooks must be an object");
  const out: HooksByEvent = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) throw new Error(`settings.hooks.${event} must be a list`);
    out[event] = entries as HookEntry[];
  }
  return out;
}

/** The tools whose use can fire a practice, a command or a file written: every Claude Code tool that writes, as host-tools.ts declares them. */
export const PRACTICE_TOOLS = CLAUDE_WRITER_MATCHER;

/** The one entry install writes for an event: the merge writes it and the check compares against it. */
export function installedEntry(options: Pick<InstallOptions, "command" | "host">, event: HookEvent): HookEntry {
  const handler: HookCommand = { type: "command", command: hookCommand(options.command, event), timeout: TIMEOUT_SECONDS };
  if (options.host === "codex" && START_EVENTS.has(event)) handler["additionalContextLimit"] = CODEX_CONTEXT_LIMIT;
  // Practices fire on a command or a written file; Claude Code runs the hook for those tools only.
  if (options.host === "claude" && event === "PreToolUse") return { matcher: PRACTICE_TOOLS, hooks: [handler] };
  return { hooks: [handler] };
}

/** The merged settings: pure, so the merge can be tested without a disk. */
export function mergeHooks(settings: Record<string, unknown>, options: Pick<InstallOptions, "command" | "host">): Record<string, unknown> {
  const hooks = hooksOf(settings);
  for (const event of HOOK_EVENTS) {
    const mine = installedEntry(options, event);
    const existing = hooks[event] ?? [];
    // Our own command leaves every entry it is in; an entry that still holds another tool's hook stays, as it was, without ours.
    const kept = existing.flatMap((entry) => {
      if (!isCoherenceEntry(entry)) return [entry];
      const theirs = entry.hooks.filter((h) => !isMine(h.command));
      return theirs.length === 0 ? [] : [{ ...entry, hooks: theirs }];
    });
    hooks[event] = [...kept, mine];
  }
  return { ...settings, hooks };
}

export { ATTRIBUTES_FILE, ATTRIBUTES_TEXT, IGNORE_FILE, IGNORE_TEXT, type AttributesAction, type IgnoreAction };

export interface InstallResult {
  path: string;
  events: HookEvent[];
  /** False when the file already held exactly what install writes. */
  changed: boolean;
  /** .coherence/.gitignore, and what install did with it. */
  ignore: { path: string; action: IgnoreAction };
  /** .coherence/.gitattributes, and what install did with it. */
  attributes: { path: string; action: AttributesAction };
}

export async function install(options: InstallOptions & { ignoreRoot?: string; ignoreRoots?: readonly string[]; local?: boolean }): Promise<InstallResult> {
  const file = settingsFile(options.host, options.local);
  if (file === undefined) throw new Error(`${options.host} keeps no personal settings file Coherence can write; install without --local`);
  const path = resolve(options.root, file);
  const read = await readSettingsFile(path);
  const merged = mergeHooks(read.value, options);
  const changed = await writeSettings(path, read, merged);
  // Each project keeps its own ignore and attributes files: a registry's leaves each get them, and the registry's top, no project, none.
  const ignoreRoots = options.ignoreRoots ?? [options.ignoreRoot ?? options.root];
  let ignore = { path: resolve(ignoreRoots[0] ?? options.root, IGNORE_FILE), action: "unchanged" as IgnoreAction };
  let attributes = { path: resolve(ignoreRoots[0] ?? options.root, ATTRIBUTES_FILE), action: "unchanged" as AttributesAction };
  for (const [i, dir] of ignoreRoots.entries()) {
    const ignored = keepIgnore(dir, true);
    const attributed = keepAttributes(dir);
    if (i === 0) {
      ignore = { path: resolve(dir, IGNORE_FILE), action: ignored };
      attributes = { path: resolve(dir, ATTRIBUTES_FILE), action: attributed };
    }
  }
  return { path, events: [...HOOK_EVENTS], changed, ignore, attributes };
}

/** One folder whose host settings carry a project's hooks, with the project's folder from there ("" for the project itself). */
export interface SettingsRoot {
  dir: string;
  sub: string;
}

/**
 * Where a project's hook settings go: the project root; and, for a project
 * nested below its repository's top, the top first, since a host launched
 * at the repository root reads only the settings there (Claude Code reads
 * the session's primary working directory's .claude/settings.json and no
 * parent's). The hooks at the top find the nested project from the event.
 */
export function settingsRoots(root: string): SettingsRoot[] {
  // With a registry, the hooks are installed once, at the repository top, and find each listed project from the event.
  const registry = registryOf(root);
  if (registry !== undefined) return [{ dir: registry.top, sub: "" }];
  const sub = nestedFolder(root);
  const top = sub === undefined ? undefined : repositoryTop(root);
  return top === undefined || sub === undefined ? [{ dir: root, sub: "" }] : [{ dir: top, sub }, { dir: root, sub: "" }];
}

/** One command of ours, by the event it sits under. */
export interface OwnedCommand {
  event: string;
  command: string;
}

/**
 * The settings with every command of ours removed: pure. An entry, an event
 * list, or the `hooks` object goes only when this removal emptied it; one
 * that was empty before stays, and so does every hook that is not ours, in
 * its place and with its matcher. Ownership is the command, wherever it sits.
 */
export function stripHooks(settings: Record<string, unknown>): { settings: Record<string, unknown>; removed: OwnedCommand[] } {
  const removed: OwnedCommand[] = [];
  if (settings["hooks"] === undefined) return { settings, removed };
  const hooks = hooksOf(settings);
  const next: HooksByEvent = {};
  for (const [event, entries] of Object.entries(hooks)) {
    let emptiedByUs = false;
    const kept = entries.flatMap((entry) => {
      if (!isCoherenceEntry(entry)) return [entry];
      for (const h of entry.hooks) if (isMine(h.command)) removed.push({ event, command: h.command });
      const theirs = entry.hooks.filter((h) => !isMine(h.command));
      if (theirs.length === 0) emptiedByUs = true;
      return theirs.length === 0 ? [] : [{ ...entry, hooks: theirs }];
    });
    if (emptiedByUs && kept.length === 0) continue;
    next[event] = kept;
  }
  if (removed.length === 0) return { settings, removed };
  const rest = { ...settings };
  if (Object.keys(next).length === 0) delete rest["hooks"];
  else rest["hooks"] = next;
  return { settings: rest, removed };
}

export interface UninstallResult {
  path: string;
  /** The commands of ours that were removed; empty when there were none. */
  removed: OwnedCommand[];
  changed: boolean;
  /** Whether this uninstall removed .coherence/.gitignore: only when it was exactly what install wrote and no host keeps a hook of ours. */
  removedIgnore: boolean;
}

/** Whether any agent host's settings still hold a command of ours, or enable Coherence's mod. */
async function anyHostInstalled(root: string): Promise<boolean> {
  if (modInstalled(root) || modInstalled(root, "project")) return true;
  for (const host of HOSTS) {
    for (const name of [SETTINGS_FILE[host], LOCAL_SETTINGS_FILE[host]]) {
      if (name === undefined) continue;
      const file = await readSettingsFile(resolve(root, name));
      if (Object.values(hooksOf(file.value)).some((entries) => entries.some(isCoherenceEntry))) return true;
    }
  }
  return false;
}

/** Remove .coherence/.gitignore and .coherence/.gitattributes, each only when it is exactly what Coherence wrote, once no host keeps our hooks; the folder goes too when that left it empty. */
async function removeIgnore(root: string): Promise<boolean> {
  if (await anyHostInstalled(root)) return false;
  const removed = removeStateFiles(root);
  await rmdir(resolve(root, STATE_DIR)).catch(() => undefined);
  return removed;
}

/** Remove what install wrote for a host, and nothing else; a second pass changes nothing. */
export async function uninstall(root: string, host: Host, local = false): Promise<UninstallResult> {
  const name = settingsFile(host, local);
  const path = resolve(root, name ?? SETTINGS_FILE[host]);
  if (name === undefined) return { path, removed: [], changed: false, removedIgnore: false };
  const file = await readSettingsFile(path);
  if (!file.exists) return { path, removed: [], changed: false, removedIgnore: await removeIgnore(root) };
  const { settings, removed } = stripHooks(file.value);
  const changed = removed.length > 0 && (await writeSettings(path, file, settings));
  return { path, removed, changed, removedIgnore: await removeIgnore(root) };
}

export function formatUninstall(host: Host, result: UninstallResult): string {
  const ignore = result.removedIgnore ? `${host}: removed ${IGNORE_FILE}, which install wrote\n` : "";
  if (result.removed.length === 0) return `${host}: ${result.path}: no Coherence hook installed${ignore === "" ? "; nothing changed" : ""}\n${ignore}`;
  const events = [...new Set(result.removed.map((r) => r.event))];
  return `${host}: removed ${result.removed.length} Coherence hook${result.removed.length === 1 ? "" : "s"} from ${result.path}: ${events.join(", ")}\n${ignore}`;
}

/** One way the installed hooks differ from what install would write. */
export type Drift =
  | { event: string; kind: "missing"; expected: string }
  | { event: string; kind: "stale"; expected: string; found: string; differences: string[]; unmatched?: string[] }
  | { event: string; kind: "extra"; found: string; reason: string };

export interface CheckResult {
  host: Host;
  path: string;
  present: boolean;
  drift: Drift[];
}

function show(value: unknown): string {
  return value === undefined ? "absent" : JSON.stringify(value);
}

/** What differs between an installed entry of ours and the entry install writes, field by field. */
function differences(found: HookEntry, expected: HookEntry): string[] {
  const out: string[] = [];
  const ours = found.hooks.filter((h) => isMine(h.command));
  const handler = ours[0]!;
  const want = expected.hooks[0]!;
  for (const key of new Set([...Object.keys(want), ...Object.keys(handler)])) {
    if (!isDeepStrictEqual(handler[key], want[key])) out.push(`${key}: installed ${show(handler[key])}; install would write ${show(want[key])}`);
  }
  if (ours.length > 1) out.push(`the entry holds ${ours.length} commands of ours; install writes one`);
  if (found.hooks.length > ours.length) out.push(`the entry is shared with ${found.hooks.length - ours.length} other hook${found.hooks.length - ours.length === 1 ? "" : "s"}; install writes an entry of its own`);
  for (const key of new Set([...Object.keys(found), ...Object.keys(expected)])) {
    if (key !== "hooks" && !isDeepStrictEqual(found[key], expected[key])) out.push(`entry field ${key}: installed ${show(found[key])}; install would write ${show(expected[key])}`);
  }
  return out;
}

/**
 * The drift between a settings value and what install would write: pure.
 * Every event install wires must hold exactly one entry of ours, equal to the
 * entry install writes; anything else of ours is named: missing, stale (each
 * field that differs), or extra (a second entry of ours for an event, or one
 * under an event install never wires).
 */
export function driftOf(settings: Record<string, unknown>, options: Pick<InstallOptions, "command" | "host">): Drift[] {
  const hooks = hooksOf(settings);
  const drift: Drift[] = [];
  const wired: ReadonlySet<string> = new Set(HOOK_EVENTS);
  for (const event of HOOK_EVENTS) {
    const expected = installedEntry(options, event);
    const want = expected.hooks[0]!.command;
    const ours = (hooks[event] ?? []).filter(isCoherenceEntry);
    if (ours.length === 0) {
      drift.push({ event, kind: "missing", expected: want });
      continue;
    }
    const exact = ours.findIndex((entry) => isDeepStrictEqual(entry, expected));
    const primary = exact === -1 ? 0 : exact;
    ours.forEach((entry, index) => {
      const found = entry.hooks.find((h) => isMine(h.command))!.command;
      if (index !== primary) drift.push({ event, kind: "extra", found, reason: "a second entry of ours for this event" });
      else if (exact === -1) {
        // A matcher that leaves out a tool that writes is the drift that keeps a practice from arriving: named, so the check says why.
        const unmatched = expected.matcher === undefined ? [] : writersUnmatched(entry.matcher);
        drift.push({ event, kind: "stale", expected: want, found, differences: differences(entry, expected), ...(unmatched.length > 0 ? { unmatched } : {}) });
      }
    });
  }
  for (const [event, entries] of Object.entries(hooks)) {
    if (wired.has(event)) continue;
    for (const entry of entries.filter(isCoherenceEntry)) {
      for (const h of entry.hooks.filter((h) => isMine(h.command))) {
        drift.push({ event, kind: "extra", found: h.command, reason: "install wires no hook for this event" });
      }
    }
  }
  return drift;
}

/** Compare one host's installed hooks with what install would write with this command prefix. */
export async function check(root: string, host: Host, command: string, local = false): Promise<CheckResult> {
  const path = resolve(root, settingsFile(host, local) ?? SETTINGS_FILE[host]);
  const file = await readSettingsFile(path);
  return { host, path, present: file.exists, drift: driftOf(file.value, { command, host }) };
}

export function formatCheck(result: CheckResult): string {
  if (result.drift.length === 0) {
    return `${result.host}: ${result.path}: all ${HOOK_EVENTS.length} events match what install would write\n`;
  }
  const events = new Set(result.drift.map((d) => d.event)).size;
  const lines = [`${result.host}: ${result.path}${result.present ? "" : " (absent)"}: ${events} event${events === 1 ? "" : "s"} drifted from what install would write`];
  for (const d of result.drift) {
    if (d.kind === "missing") lines.push(`  ${d.event}: missing; install would write: ${d.expected}`);
    else if (d.kind === "stale") lines.push(`  ${d.event}: stale`, ...d.differences.map((line) => `    ${line}`));
    else lines.push(`  ${d.event}: extra Coherence entry (${d.reason}): ${d.found}`);
  }
  if (result.drift.some((d) => d.kind !== "missing" && searchesCheckoutFirst(d.found))) lines.push(`  these hooks were ${EARLIER_SEARCH}; reinstall them`);
  const unmatched = result.drift.flatMap((d) => (d.kind === "stale" ? (d.unmatched ?? []) : []));
  if (unmatched.length > 0) lines.push(`  ${earlierMatcher(unmatched)}; reinstall them`);
  lines.push(`converge with: hooks install --host ${result.host}`);
  return lines.join("\n") + "\n";
}

export interface HostStatus {
  host: Host;
  path: string;
  present: boolean;
  /** Events for which a Coherence entry exists, with its command. */
  installed: { event: string; command: string }[];
  /** Events Coherence would wire that carry no Coherence entry. */
  missing: HookEvent[];
  /** Entries by other tools, counted per event. */
  others: Record<string, number>;
}

export async function status(root: string, host: Host, local = false): Promise<HostStatus> {
  const path = resolve(root, settingsFile(host, local) ?? SETTINGS_FILE[host]);
  let settings: Record<string, unknown>;
  let present = true;
  try {
    settings = await readSettings(path);
    present = Object.keys(settings).length > 0 || (await readFile(path, "utf8")).length > 0;
  } catch {
    settings = {};
    present = false;
  }
  const hooks = hooksOf(settings);
  const installed: { event: string; command: string }[] = [];
  const others: Record<string, number> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    for (const entry of entries) {
      if (isCoherenceEntry(entry)) {
        const command = entry.hooks.find((h) => isMine(h.command))?.command ?? "";
        installed.push({ event, command });
      } else {
        others[event] = (others[event] ?? 0) + 1;
      }
    }
  }
  const missing = HOOK_EVENTS.filter((e) => !installed.some((i) => i.event === e));
  return { host, path, present, installed, missing, others };
}

export function formatStatus(statuses: HostStatus[]): string {
  const lines: string[] = [];
  for (const s of statuses) {
    lines.push(`${s.host}: ${s.path}${s.present ? "" : " (absent)"}`);
    for (const i of s.installed) lines.push(`  ${i.event}: ${i.command}`);
    if (s.missing.length > 0) lines.push(`  not installed: ${s.missing.join(", ")}`);
    const otherEvents = Object.entries(s.others);
    if (otherEvents.length > 0) {
      lines.push(`  other hooks kept: ${otherEvents.map(([e, n]) => `${e} (${n})`).join(", ")}`);
    }
  }
  return lines.join("\n") + "\n";
}
