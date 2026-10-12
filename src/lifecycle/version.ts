/**
 * Which Coherence runs, and whether a newer one is published.
 *
 * A session is told the Coherence answering it: its version and where it
 * is, the project's installed package or the checkout $COHERENCE_HOME names,
 * and, when the other of the two differs in version, that one too. An adopter whose hooks ran an old clone at
 * ../coherence while the installed package was current saw every session
 * open with problems the installed release did not have, and nothing said
 * which Coherence spoke.
 *
 * The newest published version is read from the npm registry, at most once
 * a day (and once more for a release newer than the kept answer, which was
 * given before it was published), by a detached child a session start spawns, and kept beside
 * telemetry's state in the user's config directory; no hook waits on it and
 * a failed fetch keeps the last answer. COHERENCE_NO_UPDATE_CHECK=1, CI and
 * DO_NOT_TRACK=1 each turn it off. When the kept answer is newer than the
 * running version, the session start says so with the update command for
 * the project's package manager and the release-age setting that may hold the
 * newest back.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "./work-meter.ts";
import { LOCKFILES, type PackageManager } from "./lockfiles.ts";
import { installedPackage, projectFrom } from "../adapters/installed.ts";
import { isOwnHook, searchesCheckoutFirst } from "./hook-command.ts";
import { WRITERS, writersUnmatched } from "./host-tools.ts";
import { HOME_VAR, HOSTS, LOCAL_SETTINGS_FILE, PACKAGE_NAME, SETTINGS_FILE, SIBLING, type Host } from "./project.ts";
import { coherenceVersion, readJson, telemetryDir, truthy, writeJson, type Env } from "./telemetry.ts";

/** The registry document for the newest published release: its `version` field is the answer. */
export const REGISTRY_LATEST = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

/** How long a kept answer stands before a session start asks the registry again. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How long the detached check waits for the registry. */
export const LATEST_TIMEOUT_MS = 5000;

/**
 * This checkout's cli: the one running, by the path it was invoked through
 * when that is this file (a sibling reached through a link reads as
 * ../coherence, not as the link's target).
 */
export const OWN_CLI = ((): string => {
  // Compiled, this module is .js and so is the cli beside it.
  const own = fileURLToPath(new URL(`../cli${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  const invoked = process.argv[1];
  try {
    if (invoked !== undefined && realpathSync(invoked) === realpathSync(own)) return resolve(invoked);
  } catch {
    // An invocation path that cannot be resolved is not used.
  }
  return own;
})();

// ---------------------------------------------------------------- versions

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]{1,32}))?$/;

/** Whether `a` is a later release than `b`; a prerelease is earlier than its release. Anything that is not a version is never later. */
export function isNewer(a: string, b: string): boolean {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (pa === null || pb === null) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d > 0;
  }
  if (pa[4] === undefined) return pb[4] !== undefined;
  return pb[4] !== undefined && pa[4] > pb[4];
}

/** The version a Coherence folder declares in its package.json, or undefined when it holds none. */
export function versionAt(folder: string): string | undefined {
  const value = readJson(join(folder, "package.json"));
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return record["name"] === PACKAGE_NAME && typeof record["version"] === "string" ? record["version"] : undefined;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// ---------------------------------------------------------------- which copy runs

/** Where a running Coherence is: the project's installed package, the checkout $COHERENCE_HOME names, another checkout, or Coherence's own source. */
export type CopyKind = "installed" | "home" | "checkout" | "own";

export interface RunningCopy {
  kind: CopyKind;
  version: string;
  /** The Coherence folder: the package or the checkout. */
  folder: string;
}

/** A copy of Coherence the project could reach other than the one running, by its version. */
export interface OtherCopy {
  kind: Exclude<CopyKind, "own">;
  version: string;
  folder: string;
}

/** The installed package's folder for a project root, as Node's resolver finds it (pnpm's layout included); undefined when none is installed. */
export function installedFolder(root: string): string | undefined {
  return installedPackage(PACKAGE_NAME, projectFrom(root))?.dir;
}

/** Which Coherence `cli` is, for a project at `root`. */
export function runningCopy(root: string, cli: string = OWN_CLI, env: Env = process.env, own = false): RunningCopy {
  const folder = dirname(dirname(cli));
  const version = versionAt(folder) ?? coherenceVersion();
  if (own) return { kind: "own", version, folder };
  if (real(folder).split(sep).includes("node_modules") || folder.split(sep).includes("node_modules")) return { kind: "installed", version, folder };
  const home = env[HOME_VAR];
  if (home !== undefined && home !== "" && real(home) === real(folder)) return { kind: "home", version, folder };
  return { kind: "checkout", version, folder };
}

/** The other copies of Coherence the project could reach: the installed package and the checkout $COHERENCE_HOME names. */
export function otherCopies(root: string, running: RunningCopy, env: Env = process.env): OtherCopy[] {
  const home = env[HOME_VAR];
  const installed = installedFolder(root);
  const candidates: { kind: OtherCopy["kind"]; folder: string }[] = [
    ...(installed !== undefined ? [{ kind: "installed" as const, folder: installed }] : []),
    ...(home !== undefined && home !== "" ? [{ kind: "home" as const, folder: home }] : []),
  ];
  const seen = new Set([real(running.folder)]);
  const out: OtherCopy[] = [];
  for (const candidate of candidates) {
    const at = real(candidate.folder);
    if (seen.has(at)) continue;
    seen.add(at);
    const version = versionAt(candidate.folder);
    if (version !== undefined) out.push({ ...candidate, version });
  }
  return out;
}

function shown(root: string, folder: string): string {
  // Both as the file system names them: the resolver answers with real paths, a root may come through a link (/var and /private/var).
  const rel = relative(real(root), real(folder));
  return rel !== "" && rel.split(sep).filter((part) => part === "..").length <= 2 ? rel : folder;
}

/** What a copy of Coherence is, in the words every message uses: the installed package, the checkout $COHERENCE_HOME names, a checkout, or Coherence's own source. */
export function described(root: string, copy: { kind: CopyKind; folder: string }): string {
  switch (copy.kind) {
    case "own":
      return "this repository's own source";
    case "installed":
      return `the installed package (${shown(root, copy.folder)})`;
    case "home":
      return `the checkout ${HOME_VAR} names (${copy.folder})`;
    case "checkout":
      return `a checkout at ${shown(root, copy.folder)}`;
  }
}

/** The session start's lines on the Coherence running: one line naming it, and one more for each reachable copy at another version. */
export function copyLines(root: string, running: RunningCopy, others: readonly OtherCopy[]): string[] {
  // Only a hook command that names the cli itself runs a checkout no variable chose.
  const lines = [`Coherence ${running.version} runs this session: ${described(root, running)}${running.kind === "checkout" ? ", named by the hook command itself" : ""}.`];
  for (const other of others) {
    if (other.version === running.version) continue;
    const reach = other.kind === "installed" ? `npx --no -- coherence` : `node ${shown(root, join(other.folder, "src", "cli.ts"))}`;
    lines.push(`Another Coherence differs: ${described(root, other)} is ${other.version}, so ${reach} answers as ${other.version}, not as this session's ${running.version}; keep one, or update the other.`);
  }
  return lines;
}

/**
 * After an adopter's hooks install: which Coherence the hooks will reach,
 * named as the session start names it. `found` is the cli the located search
 * finds (undefined when none), `cli` the one running the install.
 */
export function reachNote(root: string, found: string | undefined, cli: string = OWN_CLI, env: Env = process.env): string | undefined {
  if (found === undefined) return undefined;
  const reached = runningCopy(root, found, env);
  if (real(found) === real(cli)) return `the hooks reach ${described(root, reached)}, the Coherence running this install\n`;
  return `note: the hooks will run ${described(root, reached)}, not ${described(root, runningCopy(root, cli, env))}, which runs this install\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- hooks an earlier Coherence wrote

/** The plain reason a hook of that earlier form must be reinstalled. No apostrophes and no path: it is shown as written. */
export { searchesCheckoutFirst };

export const EARLIER_SEARCH = `written by an earlier Coherence, they look for a checkout beside the project (../${SIBLING}) before the installed package, so a stale clone there answers instead of the installed release`;

/** The hosts whose settings at `dir` hold a hook of ours in that earlier form, with the file and whether it is the personal one. */
export function earlierSearchHooks(dir: string): { host: Host; file: string; local: boolean }[] {
  const out: { host: Host; file: string; local: boolean }[] = [];
  for (const host of HOSTS) {
    for (const local of [false, true]) {
      const file = local ? LOCAL_SETTINGS_FILE[host] : SETTINGS_FILE[host];
      if (file === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch {
        continue;
      }
      const hooks = isRecord(parsed) && isRecord(parsed["hooks"]) ? parsed["hooks"] : {};
      const commands = Object.values(hooks)
        .flatMap((entries) => (Array.isArray(entries) ? entries : []))
        .flatMap((entry) => (isRecord(entry) && Array.isArray(entry["hooks"]) ? entry["hooks"] : []))
        .map((h) => (isRecord(h) ? h["command"] : undefined));
      if (commands.some((c) => typeof c === "string" && searchesCheckoutFirst(c))) out.push({ host, file, local });
    }
  }
  return out;
}

/**
 * Why a Claude Code PreToolUse matcher of ours must be reinstalled: the tools
 * that write files it leaves out, which an earlier Coherence did not know of
 * or a hand narrowed. No apostrophes and no path: it is shown as written.
 */
export function earlierMatcher(missing: readonly string[]): string {
  const one = missing.length === 1;
  return `their PreToolUse matcher leaves out ${missing.join(", ")}, which write${one ? "s" : ""} files, so a practice ${one ? "it fires" : "they fire"} is not delivered before ${one ? "it runs" : "they run"}`;
}

/**
 * The Claude Code settings files at `dir` whose PreToolUse entries of ours
 * leave out a tool that writes files, with those tools. A matcher wider than
 * the one install writes leaves out nothing and is never named.
 */
export function narrowMatcherHooks(dir: string): { file: string; local: boolean; missing: string[] }[] {
  const out: { file: string; local: boolean; missing: string[] }[] = [];
  for (const local of [false, true]) {
    const file = local ? LOCAL_SETTINGS_FILE.claude : SETTINGS_FILE.claude;
    if (file === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    const hooks = isRecord(parsed) && isRecord(parsed["hooks"]) ? parsed["hooks"] : {};
    const entries = Array.isArray(hooks["PreToolUse"]) ? (hooks["PreToolUse"] as unknown[]) : [];
    const ours = entries.filter(isRecord).filter((entry) => Array.isArray(entry["hooks"]) && entry["hooks"].some((h) => isRecord(h) && isOwnHook(h["command"], "PreToolUse")));
    // A tool is covered when any entry of ours runs for it.
    const missing = ours.length === 0 ? [] : Object.keys(WRITERS.claude).filter((tool) => ours.every((entry) => writersUnmatched(entry["matcher"]).includes(tool)));
    if (missing.length > 0) out.push({ file, local, missing });
  }
  return out;
}

/** The session start's line for each settings file at `dir` whose hooks an earlier Coherence wrote must be reinstalled: they search in the earlier order, or their matcher leaves out a tool that writes; empty when none must. */
export function earlierHookLines(dir: string): string[] {
  const reinstall = (host: Host, local: boolean): string => `Reinstall them: npx --no -- coherence hooks install --host ${host}${local ? " --local" : ""}`;
  return [
    ...earlierSearchHooks(dir).map(({ host, file, local }) => `Coherence hooks in ${file}: ${EARLIER_SEARCH}. ${reinstall(host, local)}`),
    ...narrowMatcherHooks(dir).map(({ file, local, missing }) => `Coherence hooks in ${file}: ${earlierMatcher(missing)}. ${reinstall("claude", local)}`),
  ];
}

// ---------------------------------------------------------------- the newest published version

/** What the background check keeps: when it last asked, and the last answer it got. */
export interface LatestCache {
  /** When a check last started, answered or not. */
  attempted?: string;
  /** When the registry last answered. */
  checked?: string;
  /** The newest published version, as of `checked`. */
  latest?: string;
  /** The running version that started the last check, so an answer older than it is asked again once per release. */
  askedAs?: string;
}

export const latestPath = (env: Env = process.env): string => join(telemetryDir(env), "latest.json");

export function readLatest(env: Env = process.env): LatestCache {
  const value = readJson(latestPath(env));
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const text = (key: string): string | undefined => (typeof record[key] === "string" ? (record[key] as string) : undefined);
  const latest = text("latest");
  return {
    ...(text("attempted") !== undefined ? { attempted: text("attempted")! } : {}),
    ...(text("checked") !== undefined ? { checked: text("checked")! } : {}),
    ...(latest !== undefined && SEMVER.test(latest) ? { latest } : {}),
    ...(text("askedAs") !== undefined ? { askedAs: text("askedAs")! } : {}),
  };
}

/** Why the check is off, or undefined while it is on. */
export function updateCheckRefusal(env: Env = process.env): string | undefined {
  if (truthy(env["COHERENCE_NO_UPDATE_CHECK"])) return "COHERENCE_NO_UPDATE_CHECK is set";
  if (truthy(env["DO_NOT_TRACK"])) return "DO_NOT_TRACK is set";
  if (truthy(env["CI"])) return "CI is set";
  return undefined;
}

/**
 * Whether a session start now should ask the registry: the check is on and
 * the last attempt is a day old, or there was none, or the kept answer is
 * older than the running version and this version has not asked yet (an
 * answer kept before this release was published says nothing about it).
 */
export function updateCheckDue(env: Env = process.env, now: number = Date.now(), running?: string): boolean {
  if (updateCheckRefusal(env) !== undefined) return false;
  const cache = readLatest(env);
  if (running !== undefined && cache.latest !== undefined && isNewer(running, cache.latest) && cache.askedAs !== running) return true;
  const attempted = Date.parse(cache.attempted ?? "");
  return !Number.isFinite(attempted) || now - attempted >= CHECK_INTERVAL_MS || attempted > now;
}

/** Answers the registry's question: the newest version, or undefined for any failure. Tests pass their own and never reach the network. */
export type LatestFetcher = (url: string, timeoutMs: number) => Promise<string | undefined>;

export const REGISTRY_FETCHER: LatestFetcher = async (url, timeoutMs) => {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Record<string, unknown>;
    return typeof body["version"] === "string" && SEMVER.test(body["version"]) ? body["version"] : undefined;
  } catch {
    return undefined;
  }
};

/** Ask the registry once and keep its answer; a failure keeps the last answer and only the attempt's time. */
export async function refreshLatest(env: Env = process.env, fetcher: LatestFetcher = REGISTRY_FETCHER, now: () => Date = () => new Date()): Promise<LatestCache> {
  const before = readLatest(env);
  const attempted = now().toISOString();
  writeJson(latestPath(env), { ...before, attempted }, env);
  const latest = await fetcher(REGISTRY_LATEST, LATEST_TIMEOUT_MS);
  const next: LatestCache = latest === undefined ? { ...before, attempted } : { ...before, attempted, checked: now().toISOString(), latest };
  writeJson(latestPath(env), next, env);
  return next;
}

export type Spawner = (command: string, args: string[], options: { cwd: string; detached: true; stdio: "ignore" }) => { on(event: "error", listener: () => void): unknown; unref(): void };

/**
 * At a session start: when the check is due, keep the attempt's time (so a
 * second session this minute does not ask again) and spawn `version
 * --refresh` detached, its output ignored and never waited on. Never throws
 * into the hook.
 */
export function startUpdateCheck(root: string, event: string, env: Env = process.env, spawner: Spawner = spawn as unknown as Spawner, now: () => Date = () => new Date()): boolean {
  try {
    if (event !== "SessionStart") return false;
    const running = runningCopy(root, OWN_CLI, env).version;
    if (!updateCheckDue(env, now().getTime(), running)) return false;
    writeJson(latestPath(env), { ...readLatest(env), attempted: now().toISOString(), askedAs: running }, env);
    const child = spawner(process.execPath, ["--disable-warning=ExperimentalWarning", OWN_CLI, "version", "--refresh"], { cwd: root, detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the update line

export type { PackageManager };

/** The project's package manager, by the lockfile nearest above `root` (to its repository's top); npm when there is none. */
export function packageManager(root: string): PackageManager {
  let dir = root;
  for (;;) {
    for (const [file, manager] of LOCKFILES) if (existsSync(join(dir, file))) return manager;
    const up = dirname(dir);
    if (up === dir || existsSync(join(dir, ".git"))) return "npm";
    dir = up;
  }
}

/** The command that takes the project's dev dependency to `version` or later within its major. */
export function updateCommand(manager: PackageManager, version: string): string {
  const spec = `${PACKAGE_NAME}@^${version}`;
  switch (manager) {
    case "pnpm":
      return `pnpm add -D ${spec}`;
    case "yarn":
      return `yarn add -D ${spec}`;
    case "bun":
      return `bun add -d ${spec}`;
    case "npm":
      return `npm install -D ${spec}`;
  }
}

/** The release-age setting each package manager has, and the setting that exempts Coherence from it. */
export function releaseAgeNote(manager: PackageManager): string {
  switch (manager) {
    case "pnpm":
      return `pnpm's minimumReleaseAge holds a release back until it is that old; list ${PACKAGE_NAME} under minimumReleaseAgeExclude in pnpm-workspace.yaml to take it at once`;
    case "yarn":
      return `Yarn (4.10 and later, on by default from 4.15) holds a release back by its age; list ${PACKAGE_NAME} under npmPreapprovedPackages in .yarnrc.yml to take it at once`;
    case "bun":
      return `bun's install.minimumReleaseAge holds a release back; list ${PACKAGE_NAME} in install.minimumReleaseAgeExcludes in bunfig.toml to take it at once`;
    case "npm":
      return `npm's min-release-age holds a release back; min-release-age-exclude (npm 12) exempts ${PACKAGE_NAME}`;
  }
}

/** How to update the running copy: the package manager's command for an installed package, git for a checkout. */
export function updateHow(root: string, running: RunningCopy, latest: string): string {
  if (running.kind !== "installed") return `git -C ${running.folder} pull, then npm ci there`;
  const manager = packageManager(root);
  return `${updateCommand(manager, latest)}; a release-age setting may hold the newest back: ${releaseAgeNote(manager)}`;
}

/** The session start's line when the kept answer is newer than the running version; undefined otherwise, or while the check is off. */
export function updateLine(root: string, running: RunningCopy, env: Env = process.env): string | undefined {
  if (updateCheckRefusal(env) !== undefined) return undefined;
  const cache = readLatest(env);
  if (cache.latest === undefined || !isNewer(cache.latest, running.version)) return undefined;
  return `Coherence ${cache.latest} is published (the registry said so ${cache.checked ?? "earlier"}); this session runs ${running.version}. Update: ${updateHow(root, running, cache.latest)}.`;
}

/** Everything the session start says about the Coherence running: which it is, any copy at another version, and a newer release. */
export function versionBlock(root: string, own: boolean, env: Env = process.env, cli: string = OWN_CLI): string {
  const running = runningCopy(root, cli, env, own);
  const lines = copyLines(root, running, own ? [] : otherCopies(root, running, env));
  const update = updateLine(root, running, env);
  if (update !== undefined) lines.push(update);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- coherence version

/** `coherence version` (and --version, -v): the running version and where it is, then what the background check last learned. */
export function versionText(root: string, own: boolean, env: Env = process.env, cli: string = OWN_CLI): string {
  const running = runningCopy(root, cli, env, own);
  const lines = copyLines(root, running, own ? [] : otherCopies(root, running, env));
  lines[0] = `coherence ${running.version}: ${lines[0]!.replace(/^Coherence \S+ runs this session: /, "")}`;
  const cache = readLatest(env);
  const refusal = updateCheckRefusal(env);
  const said = cache.checked ?? "at an unknown time";
  if (cache.latest !== undefined && isNewer(running.version, cache.latest)) {
    // An answer kept before this release was published: it is not the latest, and this is not "current" by it.
    const next = refusal !== undefined ? "" : updateCheckDue(env, Date.now(), running.version) ? "; the next session start asks again" : `; the next check is due a day after ${cache.attempted ?? "the last"}`;
    lines.push(`latest published: not known since ${running.version}, which is newer than the registry's last answer, ${cache.latest}, given ${said}${next}`);
  } else if (cache.latest !== undefined) {
    const newer = isNewer(cache.latest, running.version);
    lines.push(`latest published: ${cache.latest}, as the registry said ${said}${newer ? `; update: ${updateHow(root, running, cache.latest)}` : "; this is current"}`);
  } else lines.push("latest published: never read yet");
  if (cache.attempted !== undefined && Date.parse(cache.attempted) > (cache.checked === undefined ? 0 : Date.parse(cache.checked))) lines.push(`last check: ${cache.attempted}, which got no answer from the registry`);
  lines.push(refusal === undefined ? `update check: on, at most once a day from a session start, in the background (${latestPath(env)}); COHERENCE_NO_UPDATE_CHECK=1 turns it off` : `update check: off, ${refusal}`);
  return lines.join("\n") + "\n";
}
