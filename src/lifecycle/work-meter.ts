/**
 * The work meter: a count of the expensive work one hook call does, kept in
 * process and scoped to that call, so a test can hold a hook to a number of
 * reads, spawns and readings where a timing would flake and would miss scale.
 *
 * What it counts, each at the one place that work passes:
 *   file read          a project file's content read for a reading: the
 *                      corpus (readCorpus), the spec model's spec, practice
 *                      and handler files, practice delivery's practice files,
 *                      the file an edit names (readProjectText)
 *   spawn              a child process or a worker thread, git or any other,
 *                      counted at node's child_process module itself,
 *                      whatever route reached it (below)
 *   project-sized spawn  a spawn whose cost grows with the project whatever
 *                      it prints: git listing, searching or comparing the
 *                      tree; any spawn through a shell, whose command line
 *                      cannot be read for what it runs; and a recursive tool
 *                      (grep -r, find, rg, ls -R, fd, du, tree)
 *   spawn output       the bytes a child wrote to its standard output, for
 *                      the synchronous forms and a promised execFile (a
 *                      streamed spawn, the language servers' and the warm
 *                      server's, is not counted)
 *   coverage reading   one vocabulary coverage reading (lexiconCoverage)
 *   spec model         one spec model load (loadSpecModel)
 *   server request     one request to a language server or to the warm
 *                      server (JsonRpcClient.request, LineClient.request)
 *   phrase comparison  one test of a line against one lexicon phrase in the
 *                      coverage scan, added once per reading
 *
 * Not counted here: a stat, a directory walk, a git listing's own length, and
 * Coherence's own state under .coherence (feed cursors, traces, the kept
 * parses and indexes, run records, the journal). The size tests count those
 * too, below the meter, at the file system (fs-count-fixture.ts), so a read
 * that slips past these doors still shows there.
 *
 * runHook opens the scope and closes it; a count outside any scope is one
 * comparison against undefined, so the meter costs nothing a hook can feel.
 */

import { createRequire, syncBuiltinESMExports } from "node:module";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export type { ChildProcess } from "node:child_process";

export const WORK_KINDS = ["file read", "spawn", "project-sized spawn", "spawn output", "coverage reading", "spec model", "server request", "phrase comparison"] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

/** What one scope counted: a number per kind, and, for reads and spawns, what each was. */
export interface Work {
  counts: Record<WorkKind, number>;
  /** Each file read, as "<what> <path>", in order. */
  reads: string[];
  /** Each spawn, as its command line, in order. */
  spawns: string[];
  /** The bytes each command line's spawns wrote to standard output, summed by command line. */
  outputs: Record<string, number>;
}

function emptyWork(): Work {
  return { counts: Object.fromEntries(WORK_KINDS.map((k) => [k, 0])) as Record<WorkKind, number>, reads: [], spawns: [], outputs: {} };
}

let current: Work | undefined;
let lastHook: Work | undefined;

/** A scope opened: the work it counts and the scope it replaced, restored when it closes. */
export interface WorkScope {
  work: Work;
  outer: Work | undefined;
}

/** Open a scope; work counted until it closes is its own. runHook is the one caller outside the tests. */
export function openWork(): WorkScope {
  const scope = { work: emptyWork(), outer: current };
  current = scope.work;
  return scope;
}

/**
 * Close a scope, restore the one it replaced, and keep it as the last hook
 * call's work. The work an inner scope counted is the outer scope's too, so
 * a scope opened inside another never hides work from it.
 */
export function closeWork(scope: WorkScope): Work {
  current = scope.outer;
  if (scope.outer !== undefined) {
    for (const kind of WORK_KINDS) scope.outer.counts[kind] += scope.work.counts[kind];
    scope.outer.reads.push(...scope.work.reads);
    scope.outer.spawns.push(...scope.work.spawns);
    for (const [line, bytes] of Object.entries(scope.work.outputs)) scope.outer.outputs[line] = (scope.outer.outputs[line] ?? 0) + bytes;
  }
  lastHook = scope.work;
  return scope.work;
}

/** The work the last closed scope counted: the last hook call's, for a test that ran one. */
export function lastHookWork(): Work | undefined {
  return lastHook;
}

/** Count `n` of one kind in the open scope; nothing when none is open. */
export function countWork(kind: WorkKind, n = 1): void {
  if (current === undefined) return;
  current.counts[kind] += n;
}

/** Whether a scope is open, so a caller builds a label only when one will be kept. */
export function metering(): boolean {
  return current !== undefined;
}

function countRead(what: string, path: string): void {
  if (current === undefined) return;
  current.counts["file read"] += 1;
  current.reads.push(`${what} ${path}`);
}

/** What a read is for: the corpus of a reading, a spec, a practice, a source file the spec model or an edit names. */
export type ReadKind = "corpus" | "spec" | "practice" | "source" | "record";

/** The door a reading reads a project file's text through, counted. */
export function readProjectText(path: string, what: ReadKind): string {
  countRead(what, path);
  return readFileSync(path, "utf8");
}

/** The same door, asynchronous. */
export function readProjectTextAsync(path: string, what: ReadKind): Promise<string> {
  countRead(what, path);
  return readFile(path, "utf8");
}

function commandLine(args: readonly unknown[]): string {
  const argv = Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [];
  return [String(args[0]), ...argv].join(" ");
}

/** Shells: a command line run through one can run anything, so its cost is never read off its first word. */
const SHELLS = /^(sh|bash|zsh|dash|ksh|mksh|fish|csh|tcsh|busybox|cmd|powershell|pwsh)(\.exe)?$/i;
/** Tools that walk a tree whatever they print. */
const WALKERS = /^(find|rg|fd|fdfind|du|tree|ag|ack)(\.exe)?$/i;

/**
 * Whether a command line's cost is the project's, not its own, so a size
 * test budgets such spawns by count as well as by output: git listing,
 * searching or comparing the tree (ls-files, grep, status, diff, log over
 * paths); any spawn through a shell (`sh -c`, `bash -c`, exec with a string,
 * an option `shell`), whose line cannot be read for what it runs; and a
 * recursive tool (grep -r, find, rg, ls -R, and the like).
 */
export function projectSized(line: string, viaShell = false): boolean {
  if (viaShell) return true;
  if (/(^|[\\/])git(\.exe)?\s(?:.*\s)?(ls-files|grep|status|diff|ls-tree|log|rev-list|check-ignore)\b/.test(line)) return true;
  const [first = "", ...rest] = line.trim().split(/\s+/);
  const tool = first.split(/[\\/]/).pop() ?? "";
  if (SHELLS.test(tool) || WALKERS.test(tool)) return true;
  if (/^[ef]?grep$/i.test(tool)) return rest.some((a) => a === "--recursive" || a === "--dereference-recursive" || /^-[a-zA-Z]*[rR]/.test(a));
  if (/^ls$/i.test(tool)) return rest.some((a) => a === "--recursive" || /^-[a-zA-Z]*R/.test(a));
  return false;
}

/** Whether a spawn's options ask for a shell: `{ shell: true }` or a shell's path. */
function shellOption(given: readonly unknown[]): boolean {
  const options = given.find((a, i) => i > 0 && a !== null && typeof a === "object" && !Array.isArray(a)) as { shell?: unknown } | undefined;
  return options !== undefined && options.shell !== undefined && options.shell !== false;
}

/**
 * A spawn as a watcher sees it: the program, its arguments (for exec, the one
 * command string), and the folder it runs in when its options name one.
 */
export interface WatchedSpawn {
  file: string;
  args: string[];
  cwd: string | undefined;
  /** Whether it runs detached: work the spawner starts and lets go, never waits on. */
  detached: boolean;
}

const watchers: ((spawn: WatchedSpawn) => void)[] = [];

/**
 * Hear every spawn this process makes from now on, inside a scope or not, at
 * the same place the meter counts them: the test suite's leak guard counts
 * the file's launches of Coherence's own command line with it.
 */
export function watchSpawns(watcher: (spawn: WatchedSpawn) => void): void {
  watchers.push(watcher);
}

function tellWatchers(given: readonly unknown[]): void {
  if (watchers.length === 0) return;
  const args = Array.isArray(given[1]) ? (given[1] as unknown[]).map(String) : [];
  const options = given.find((a, i) => i > 0 && a !== null && typeof a === "object" && !Array.isArray(a)) as { cwd?: unknown; detached?: unknown } | undefined;
  const cwd = options?.cwd instanceof URL ? options.cwd.pathname : typeof options?.cwd === "string" ? options.cwd : undefined;
  const spawn = { file: String(given[0] ?? ""), args, cwd, detached: options?.detached === true };
  for (const watcher of watchers) watcher(spawn);
}

function countSpawn(args: readonly unknown[], viaShell = false): void {
  if (current === undefined) return;
  current.counts.spawn += 1;
  const line = commandLine(args);
  current.spawns.push(line);
  if (projectSized(line, viaShell)) current.counts["project-sized spawn"] += 1;
}

type Callable = (...args: unknown[]) => unknown;

/**
 * The environment variables that change what a git pathspec means: with
 * GIT_LITERAL_PATHSPECS set, `:(glob)**\/*.spec.md` matches no file, and a
 * listing of the specs comes back empty without an error. Coherence's git
 * calls never inherit them; every one passes here.
 */
export const PATHSPEC_ENV = ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"] as const;

/** A git call's arguments with an environment that holds none of PATHSPEC_ENV; any other call's as they are. */
function controlled(args: unknown[]): unknown[] {
  const file = String(args[0] ?? "");
  if (!/(^|[\\/])git(\.exe)?$/.test(file)) return args;
  const at = Array.isArray(args[1]) ? 2 : 1;
  const given = args[at];
  const options = typeof given === "object" && given !== null ? (given as { env?: NodeJS.ProcessEnv }) : {};
  const env = { ...(options.env ?? process.env) };
  for (const name of PATHSPEC_ENV) delete env[name];
  const next = [...args];
  if (typeof given === "function" || given === undefined) next.splice(at, 0, { env });
  else next[at] = { ...options, env };
  return next;
}

/** The bytes a child wrote to its standard output, counted: a listing that grows with the project is work the hook pays to read. */
function countOutput(args: readonly unknown[], stdout: unknown): void {
  if (current === undefined || stdout === undefined || stdout === null) return;
  const bytes = typeof stdout === "string" ? Buffer.byteLength(stdout) : Buffer.isBuffer(stdout) ? stdout.length : 0;
  current.counts["spawn output"] += bytes;
  const line = commandLine(args);
  current.outputs[line] = (current.outputs[line] ?? 0) + bytes;
}

/* ------------------------------------------------------------ spawns, at runtime */

/**
 * Every spawn this process makes is counted at the one object every route to
 * a spawn reaches: node's child_process module itself. Its spawning functions
 * are replaced, once, at load, with counted ones, and syncBuiltinESMExports
 * carries the replacement to every module that imported them by name, so a
 * spawn through a static import, a dynamic import of a computed name,
 * process.getBuiltinModule, createRequire, code vm runs, or a third-party
 * module (execa spawns through child_process too) is counted alike. A worker
 * thread is counted as a spawn. A call one counted function makes of another
 * (exec runs execFile) counts once. A counted function carries every
 * property its original does, and its promisified form returns the
 * original's own promise, `.child` included, so nothing that calls it can
 * tell it from node's.
 *
 * The patch is installed at the CLI's first import, before any other module
 * loads (cli.ts), so no Coherence module and no library it loads can take
 * the spawning functions before they are counted. What stays uncounted, and
 * no test here can catch: a CommonJS module that captured spawnSync (or any
 * of them) by destructuring before this module ran, which only code loaded
 * ahead of the CLI can be; process.binding('spawn_sync') and node's other
 * internal bindings, which spawn below the module; and a native addon that
 * starts a process itself.
 */
const cjs = createRequire(import.meta.url);
const childModule = cjs("node:child_process") as Record<string, unknown> & { __metered?: true };
const workerModule = cjs("node:worker_threads") as Record<string, unknown>;

let depth = 0;

function counted(name: string, sync: boolean): void {
  const original = childModule[name] as (Callable & { [key: symbol]: unknown }) | undefined;
  if (typeof original !== "function") return;
  const wrapped = function (this: unknown, ...given: unknown[]): unknown {
    const outer = depth === 0;
    // exec's line is its command; the others' is the file and its arguments.
    const args = name === "exec" || name === "execSync" ? [String(given[0] ?? "")] : given;
    const call = name === "exec" || name === "execSync" ? given : controlled(given);
    // exec and execSync always run their string through a shell.
    if (outer) {
      countSpawn(args, name === "exec" || name === "execSync" || shellOption(given));
      tellWatchers(given);
    }
    depth += 1;
    try {
      if (!sync && outer) {
        const last = call.length - 1;
        const cb = call[last];
        if (typeof cb === "function") call[last] = (error: unknown, stdout: unknown, stderr: unknown) => {
          countOutput(args, stdout);
          (cb as Callable)(error, stdout, stderr);
        };
      }
      const result = original.apply(this, call);
      if (sync && outer) countOutput(args, name === "spawnSync" ? (result as { stdout?: unknown } | undefined)?.stdout : result);
      return result;
    } finally {
      depth -= 1;
    }
  };
  // Every property the original carries is carried over (its name and length, and anything node or a library hung on it), so the
  // counted function reads as the original wherever it is inspected.
  for (const key of Reflect.ownKeys(original)) {
    if (key === "prototype" || key === promisify.custom) continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor !== undefined && (Object.getOwnPropertyDescriptor(wrapped, key)?.configurable ?? true)) Object.defineProperty(wrapped, key, descriptor);
  }
  // promisify(execFile) and promisify(exec) call the original's own promisified form, which resolves to { stdout, stderr } and carries
  // the child on the promise as .child; the counted form returns that very promise, so its shape is node's, .child included, and the
  // output is counted on a branch of it that never changes how it settles.
  const custom = original[promisify.custom] as Callable | undefined;
  if (custom !== undefined) {
    const promised = function (this: unknown, ...given: unknown[]): unknown {
      const args = name === "exec" ? [String(given[0] ?? "")] : given;
      const call = name === "exec" ? given : controlled(given);
      const outer = depth === 0;
      if (outer) {
        countSpawn(args, name === "exec" || shellOption(given));
        tellWatchers(given);
      }
      depth += 1;
      let result: unknown;
      try {
        result = custom.apply(this, call);
      } finally {
        depth -= 1;
      }
      if (outer && result instanceof Promise) result.then((value: { stdout?: unknown } | undefined) => countOutput(args, value?.stdout), () => {});
      return result;
    };
    for (const key of Reflect.ownKeys(custom)) {
      if (key === "prototype") continue;
      const descriptor = Object.getOwnPropertyDescriptor(custom, key);
      if (descriptor !== undefined && (Object.getOwnPropertyDescriptor(promised, key)?.configurable ?? true)) Object.defineProperty(promised, key, descriptor);
    }
    Object.defineProperty(wrapped, promisify.custom, { value: promised, configurable: true, enumerable: false, writable: true });
  }
  childModule[name] = wrapped;
}

if (childModule.__metered !== true) {
  childModule.__metered = true;
  for (const name of ["spawn", "execFile", "exec", "fork"]) counted(name, false);
  for (const name of ["spawnSync", "execFileSync", "execSync"]) counted(name, true);
  const Worker = workerModule["Worker"] as (new (...args: unknown[]) => object) | undefined;
  if (Worker !== undefined) {
    workerModule["Worker"] = class MeteredWorker extends Worker {
      constructor(...args: unknown[]) {
        countSpawn(["worker", [typeof args[0] === "string" ? args[0].slice(0, 80) : String(args[0])]]);
        super(...args);
      }
    };
  }
  syncBuiltinESMExports();
}

/** child_process.spawnSync, counted where every spawn is (above). */
export const spawnSync = ((...args: unknown[]) => (childModule["spawnSync"] as Callable)(...args)) as typeof import("node:child_process").spawnSync;

/** child_process.execFileSync, counted where every spawn is. */
export const execFileSync = ((...args: unknown[]) => (childModule["execFileSync"] as Callable)(...args)) as typeof import("node:child_process").execFileSync;

/** child_process.spawn, counted where every spawn is. */
export const spawn = ((...args: unknown[]) => (childModule["spawn"] as Callable)(...args)) as typeof import("node:child_process").spawn;

/** child_process.execFile, counted where every spawn is; promisify of it resolves to { stdout, stderr } as the original's does. */
export const execFile = Object.defineProperty(
  (...args: unknown[]) => (childModule["execFile"] as Callable)(...args),
  promisify.custom,
  { value: (...args: unknown[]) => ((childModule["execFile"] as Record<symbol, Callable>)[promisify.custom] as Callable)(...args) },
) as unknown as typeof import("node:child_process").execFile;
