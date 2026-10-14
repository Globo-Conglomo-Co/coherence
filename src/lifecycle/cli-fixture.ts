/**
 * The command line, run in the test file's own process: `cli(args, { cwd,
 * env, stdin })` answers `{ status, stdout, stderr }` as a spawned `node
 * src/cli.ts <args>` would, without paying Node's start and Coherence's load
 * for each call. The load is paid once per test file, by the file's first
 * call.
 *
 *   const { status, stdout } = await cli(["spec", "--check"], { cwd: root });
 *
 * One call runs cli.ts's own main over buffers for stdout and stderr, the
 * given stdin, the given folder and environment. A usage error or a throw
 * ends the call with the code and the message the binary exits with.
 *
 * What a long-lived process would otherwise carry from one call to the next
 * is undone around each call:
 * - the folder and the environment are process-global, so each call moves
 *   into its own and both are put back after it, whatever it did; a second
 *   call while one runs is refused, loudly, since the two would share them;
 * - the answers modules keep per process about a project (whether a folder
 *   is a repository, its registry, the files it owns) are forgotten before
 *   each call (process-caches.ts), so a test that runs git init or ignores a
 *   file between two calls gets the second call's answers, as a fresh process
 *   would.
 *
 * Not in-process: hook-serve and serve, which serve the process's own streams
 * until it ends. A test of those, and the one spawned end-to-end test each
 * command family keeps, lives in a `*.e2e.ts` file, where the leak guard's
 * spawn budget does not apply (enforcement/leak-guard.ts).
 */

import { Readable } from "node:stream";
import type { CommandCall, CommandOutput } from "../cli.ts";
import { forgetPerProcess } from "./process-caches.ts";

export interface CliOptions {
  /** The folder the command runs in; the test process's own by default. */
  cwd?: string;
  /** The whole environment the command sees, as spawnSync's env replaces it; the test process's own by default. */
  env?: NodeJS.ProcessEnv;
  /** What the command reads on stdin; nothing by default, as a spawn with no input. */
  stdin?: string;
}

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

type CliModule = typeof import("../cli.ts");

/** cli.ts runs nothing at load in a process marked so; it is loaded once, on the first call. */
const IN_PROCESS = Symbol.for("coherence.cli.in-process");
let loaded: Promise<CliModule> | undefined;

function load(): Promise<CliModule> {
  (globalThis as Record<symbol, unknown>)[IN_PROCESS] = true;
  loaded ??= import("../cli.ts");
  return loaded;
}

let running: string | undefined;

function buffer(chunks: string[]): CommandOutput {
  return {
    write(text: string, done?: (error?: Error | null) => void): boolean {
      chunks.push(String(text));
      done?.(null);
      return true;
    },
  };
}

/** Make the environment exactly `next`, in place, so every module that holds process.env reads it; returns the one it replaced. */
function swapEnvironment(next: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const before = { ...process.env };
  for (const key of Object.keys(process.env)) if (!(key in next)) delete process.env[key];
  for (const [key, value] of Object.entries(next)) if (value !== undefined) process.env[key] = value;
  return before;
}

/** Run `coherence <args>` in this process: its exit status and everything it wrote to stdout and stderr. */
export async function cli(args: readonly string[], options: CliOptions = {}): Promise<CliResult> {
  if (running !== undefined) {
    throw new Error(
      `cli(): "${args.join(" ")}" started while "${running}" is still running in this process. The folder and the environment are process-global, ` +
        `so two calls at once would share them: await each call before the next (Promise.all over cli() is refused for this reason).`,
    );
  }
  running = args.join(" ");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const folder = process.cwd();
  const cwd = options.cwd ?? folder;
  let environment: NodeJS.ProcessEnv | undefined;
  let status: number;
  try {
    const { main, endedAt, PROCESS_VERBS } = await load();
    if (args[0] !== undefined && PROCESS_VERBS.has(args[0])) {
      throw new Error(`cli(): ${args[0]} serves the process's own streams until the process ends; spawn it, in a *.e2e.ts file`);
    }
    environment = options.env === undefined ? undefined : swapEnvironment(options.env);
    process.chdir(cwd);
    forgetPerProcess();
    const call: CommandCall = {
      stdout: buffer(stdout),
      stderr: buffer(stderr),
      stdin: Readable.from(options.stdin === undefined ? [] : [Buffer.from(options.stdin)]),
      // As the binary reads it: process.cwd() after the move, the real path where cwd went through a symbolic link.
      cwd: process.cwd(),
      env: process.env,
      startedAt: Date.now(),
    };
    try {
      status = await main([...args], call);
    } catch (error) {
      const ended = endedAt(error);
      stderr.push(ended.text);
      status = ended.code;
    }
  } finally {
    process.chdir(folder);
    if (environment !== undefined) swapEnvironment(environment);
    running = undefined;
  }
  return { status, stdout: stdout.join(""), stderr: stderr.join("") };
}
