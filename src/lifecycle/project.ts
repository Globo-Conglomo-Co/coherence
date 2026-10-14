/**
 * Where a project keeps its lexicon, where Coherence keeps its own, and
 * where each host keeps the settings file that carries the hook.
 *
 * `coherence.config.json` at the project root may name the project lexicon
 * under `lexicon`; otherwise `lexicon.json` at the root is used when it
 * exists. Coherence's own lexicon travels with this package.
 */

import { spawnSync } from "./work-meter.ts";
import { perProcess } from "./process-caches.ts";
import { existsSync, realpathSync, statSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLexicon, rejectedNames, type Lexicon } from "./lexicon.ts";
import { STORE_FOLDERS } from "../journal/stores.ts";
import { DEFAULT_PROJECT_LEXICON, configuredName, effectiveConfig, leafOf, projectName, registryOf, under, type Registry } from "../adapters/project-config.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Coherence's own lexicon, relative to this source tree. */
export const COHERENCE_LEXICON = resolve(here, "..", "..", "docs", "lexicon.json");

export const CONFIG_FILE = "coherence.config.json";
export { DEFAULT_PROJECT_LEXICON };

import { LOCAL_SETTINGS_FILE, SETTINGS_FILE } from "./hosts.ts";
export { HOST_FOLDER, HOSTS, isHost, LOCAL_SETTINGS_FILE, SETTINGS_FILE, type Host } from "./hosts.ts";

/** The harness's own name for the project directory, honored when it agrees with where the process runs. */
export const PROJECT_DIR_VAR = "CLAUDE_PROJECT_DIR";

/** A path with its symbolic links followed where they can be, so two spellings of one directory compare equal. */
export function real(path: string): string {
  let existing=resolve(path); const suffix:string[]=[];
  while(!existsSync(existing) && dirname(existing)!==existing) { suffix.unshift(basename(existing)); existing=dirname(existing); }
  try { return resolve(realpathSync(existing),...suffix); }
  catch { return resolve(path); }
}

/** Whether `path` is `root` itself or lies under it, comparing the directories rather than their spellings. */
export function within(root: string, path: string): boolean {
  const rel = relative(real(root), real(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The project root the hook was installed for, or nothing when no
 * installation can be pointed at: the harness's own name for the project when
 * that name contains the directory the process was started in, else the
 * nearest directory at or above that one holding a host settings file. This
 * is the tree the hook may read and write, whatever cwd arrives on stdin.
 *
 * The environment variable is checked for agreement because a process started
 * elsewhere has inherited a name that is not about the tree it is running in.
 * Nothing is returned rather than a guess: a hook the host ran from outside
 * any installation has no tree to defend, and refusing every event on a guess
 * would be worse than answering the cwd it was handed.
 */
export function installedRoot(fallback: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const start = real(fallback);
  const named = env[PROJECT_DIR_VAR];
  if (typeof named === "string" && named !== "" && existsSync(named) && within(named, start)) return real(named);
  let dir = start;
  for (;;) {
    if ([...Object.values(SETTINGS_FILE), ...Object.values(LOCAL_SETTINGS_FILE)].some((file) => existsSync(join(dir, file)))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export interface ProjectLexicons {
  root: string;
  coherence: Lexicon;
  /** Absent when the project declares none; identical to `coherence` is folded away. */
  project: Lexicon | undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The project lexicon path the config names, or the default when present, or undefined. */
export async function projectLexiconPath(root: string): Promise<string | undefined> {
  const configPath = resolve(root, CONFIG_FILE);
  // The lexicon key is the project's own, never inherited from a registry, so only its own file is read here.
  if (await exists(configPath)) {
    let config: unknown;
    try {
      config = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      throw new Error(`${configPath}: not valid JSON (${(error as Error).message})`);
    }
    if (typeof config === "object" && config !== null && !Array.isArray(config)) {
      const record = config as Record<string, unknown>;
      for (const old of await retiredLexiconNames()) {
        if (old in record) throw new Error(`${configPath}: the key "${old}" names the project lexicon under its retired name; rename the key to "lexicon"`);
      }
      const named = record["lexicon"];
      if (typeof named === "string") return resolve(root, named);
    }
  }
  const fallback = resolve(root, DEFAULT_PROJECT_LEXICON);
  if (await exists(fallback)) return fallback;
  for (const old of await retiredLexiconNames()) {
    const file = `${old}.json`;
    if (await exists(resolve(root, file))) {
      throw new Error(`${resolve(root, file)}: the project lexicon is now ${DEFAULT_PROJECT_LEXICON}; migrate with: git mv ${file} ${DEFAULT_PROJECT_LEXICON}`);
    }
  }
  return undefined;
}

/**
 * The names the lexicon concept was known by before it was renamed, read from
 * Coherence's own lexicon (its rejected single-word names), so the old
 * spelling lives only as data. A project still carrying its file or config key
 * under one of them is told the one-line migration; the old name is never read
 * as a fallback.
 */
export async function retiredLexiconNames(): Promise<string[]> {
  const own = await loadLexicon(COHERENCE_LEXICON);
  return rejectedNames(own)
    .filter((r) => r.concept === "lexicon" && /^[a-z]+$/.test(r.name))
    .map((r) => r.name);
}

/**
 * The project facts vocabulary coverage reads from the config: the project's
 * own name (`name`) and the names it vouches for as well known (`wellKnown`),
 * which no tool could derive. A missing or partial config is no facts.
 */
export interface VocabularyFacts {
  name: string | undefined;
  wellKnown: string[];
}

export async function vocabularyFacts(root: string): Promise<VocabularyFacts> {
  const facts: VocabularyFacts = { name: undefined, wellKnown: [] };
  // wellKnown is inherited from a registry and added to; name is the project's own.
  const found = effectiveConfig(root);
  if (found === undefined) return facts;
  const record = found.record;
  facts.name = configuredName(root);
  const named = record["wellKnown"];
  if (Array.isArray(named)) facts.wellKnown = named.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim());
  return facts;
}

/**
 * The record stores' folders under .coherence: one append-only JSONL file per
 * session, whose readers order and fold records by their content, never by
 * line. Two branches append to the same session's file, so git merges each
 * with the union of both sides' lines (state-files.ts). The stores are named
 * once, in journal/stores.ts; this is that table's folders.
 */
export const RECORD_STORES: readonly string[] = STORE_FOLDERS;

/** The folders under .coherence a project commits: the record stores, and the project's own hook voice. Everything else there is regenerated. */
export const DURABLE_FOLDERS: readonly string[] = [...RECORD_STORES, "hooks"];

/**
 * The project a command run from `cwd` acts on: the nearest folder, up to the
 * top of the git checkout it is in, that holds coherence.config.json; failing
 * that, the nearest that holds .coherence; failing both, `cwd` itself. A
 * command run from a subfolder then reads and writes the project's records,
 * never a second store it would create where it stood.
 */
export function projectRoot(cwd: string): string {
  const start = resolve(cwd);
  // A registry at the repository top decides first, with no walk up: the leaf the cwd lies in, or the one leaf below it.
  const registry = registryOf(start);
  if (registry !== undefined) {
    const route = registryRoute(registry, [], start);
    return route.kind === "project" ? route.root : start;
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8" });
  const ceiling = top.status === 0 && top.stdout.trim() !== "" ? realpathOr(top.stdout.trim()) : undefined;
  const found = enclosingProject(start, ceiling);
  if (found !== undefined) return found;
  // Above every project: a monorepo whose one adopted folder lies below the cwd is that folder's, so a command run at the repository root reads and writes its records.
  const below = nestedProjects(start);
  return below.length === 1 ? below[0]! : start;
}

function holds(dir: string, name: string, folder: boolean): boolean {
  try {
    const stat = statSync(join(dir, name));
    return folder ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

/** Whether `dir` is itself a project's root: a leaf its repository's registry lists, or, with no registry, a folder holding coherence.config.json or .coherence. */
export function holdsProject(dir: string): boolean {
  const registry = registryOf(dir);
  if (registry !== undefined) return registry.leaves.includes(real(dir));
  return holds(dir, CONFIG_FILE, false) || holds(dir, ".coherence", true);
}

/**
 * Where an event belongs in a repository with a registry: each subject (a
 * file a tool writes) in the leaf whose folder is its longest listed prefix;
 * with no subjects, the leaf the cwd lies in, else the one leaf below the cwd
 * (`above`), else several or none. Anything in no leaf is outside, whatever
 * config it holds. No walk up and no git: the registry's list decides.
 */
export function registryRoute(registry: Registry, subjects: readonly string[], cwd: string): HookProject {
  const spelled = real;
  if (subjects.length > 0) {
    for (const subject of subjects) {
      const leaf = leafOf(registry, spelled(subject));
      if (leaf !== undefined) return { kind: "project", root: leaf };
    }
    return { kind: "outside" };
  }
  const here = spelled(cwd);
  const leaf = leafOf(registry, here);
  if (leaf !== undefined) return { kind: "project", root: leaf };
  const below = registry.leaves.filter((l) => under(here, l));
  if (below.length === 1) return { kind: "project", root: below[0]!, above: true };
  return below.length === 0 ? { kind: "outside" } : { kind: "several", projects: below };
}

/**
 * The nearest folder at or above `start`, up to `ceiling` (a real path,
 * included) or the filesystem's root, that holds coherence.config.json;
 * failing that, the nearest that holds .coherence; failing both, nothing.
 * Stats only: no git, no read.
 */
export function enclosingProject(start: string, ceiling?: string): string | undefined {
  const ancestors: string[] = [];
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    ancestors.push(dir);
    if ((ceiling !== undefined && realpathOr(dir) === ceiling) || dirname(dir) === dir) break;
  }
  return ancestors.find((dir) => holds(dir, CONFIG_FILE, false)) ?? ancestors.find((dir) => holds(dir, ".coherence", true));
}

/**
 * The project folders at or below `dir`, absolute and sorted: each folder
 * holding a coherence.config.json git lists there (tracked, or untracked and
 * not ignored). One git call; outside a repository, none.
 */
export function nestedProjects(dir: string): string[] {
  const base = resolve(dir);
  // One process asks this of one folder more than once (the command's root, then the hook's event); a listing a moment old answers again.
  const held = nestedListings.get(base);
  if (held !== undefined && Date.now() - held.at < NESTED_LISTING_MS) return held.projects;
  const projects = listNestedProjects(base);
  nestedListings.set(base, { at: Date.now(), projects });
  return projects;
}

/** How long one listing of the projects below a folder answers again within a process. */
const NESTED_LISTING_MS = 2_000;
const nestedListings = perProcess(new Map<string, { at: number; projects: string[] }>());

function listNestedProjects(base: string): string[] {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", `:(glob)**/${CONFIG_FILE}`], { cwd: base, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (listed.status !== 0) return [];
  return [...new Set(listed.stdout.split("\0").filter((f) => f !== "" && basename(f) === CONFIG_FILE).map((f) => resolve(base, dirname(f))))].sort();
}

/**
 * Where a hook event belongs: to one project, to none (outside every
 * project, ignored), or to several the event cannot choose between. `above`
 * marks a project reached from a cwd above it (the repository root), not
 * from a cwd or a file inside it.
 */
export type HookProject = { kind: "project"; root: string; above?: true } | { kind: "outside" } | { kind: "several"; projects: string[] };

/**
 * The project a hook event belongs to, for a hook installed at `base` (the
 * folder holding the host's settings, or the cwd when none does). A project
 * at `base` itself is the project, as it always was. Otherwise the event's
 * subjects decide: the files a tool writes, or, for an event that names
 * none, its cwd; the nearest project at or above a subject, up to `base`, is
 * the event's. A cwd above the projects (the repository root, where the host
 * runs) belongs to the one project below it. With no project anywhere under
 * `base`, `base` is the project, as before any was nested. Anything else is
 * outside: the rest of the repository is not the project's.
 */
export function hookProject(base: string, subjects: readonly string[], cwd: string): HookProject {
  // The registry is the first lookup: with one, the leaves it lists are the only projects.
  const registry = registryOf(base);
  if (registry !== undefined) return registryRoute(registry, subjects, cwd);
  if (holdsProject(base)) return { kind: "project", root: base };
  const ceiling = realpathOr(base);
  const starts = subjects.length > 0 ? subjects.map((file) => dirname(file)) : [cwd];
  for (const start of starts) {
    if (!within(base, start)) continue;
    const found = enclosingProject(start, ceiling);
    if (found !== undefined) return { kind: "project", root: found };
  }
  const nested = nestedProjects(base);
  if (nested.length === 0) return { kind: "project", root: base };
  if (subjects.length > 0) return { kind: "outside" };
  const below = nested.filter((project) => within(cwd, project));
  if (below.length === 1) return { kind: "project", root: below[0]!, above: true };
  return below.length === 0 ? { kind: "outside" } : { kind: "several", projects: below };
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Coherence's own package name: a root whose package.json carries it is Coherence's own checkout. */
export const PACKAGE_NAME = "@posthog/coherence";

/** The variable that names a checkout of Coherence a developer of Coherence runs instead of the installed package. */
export const HOME_VAR = "COHERENCE_HOME";

/** The folder beside the project that hooks an earlier release wrote looked in; no hook runs it now. */
export const SIBLING = "coherence";

/** Whether the project at `root` is Coherence itself, whose CLI is its own source tree rather than an installed bin. */
export async function isCoherenceItself(root: string): Promise<boolean> {
  try {
    const pkg: unknown = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    return typeof pkg === "object" && pkg !== null && (pkg as Record<string, unknown>)["name"] === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** Both layers for a project root. */
export async function loadProjectLexicons(root: string): Promise<ProjectLexicons> {
  const coherence = await loadLexicon(COHERENCE_LEXICON);
  coherence.project ??= "coherence";
  const path = await projectLexiconPath(root);
  const project = path === undefined || path === COHERENCE_LEXICON ? undefined : await loadLexicon(path);
  // The project's name is the config's (projectName); a name the file stored is read only where the config gives none.
  if (project !== undefined) project.project = projectName(root, project.project);
  return { root, coherence, project };
}
