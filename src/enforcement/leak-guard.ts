/**
 * The test suite's leak guard: loaded into every test file's process with
 * `--import`, it fails the file when the file leaves a process or a temp
 * folder behind, and names each one.
 *
 * Each test file gets a folder of its own under the system temp folder,
 * and TMPDIR points at it for the file and everything it spawns. So every
 * `mkdtemp(join(tmpdir(), ...))` a test, a fixture, or the code under test
 * makes lands inside it, and every process the file starts, detached or
 * not, carries that folder in its environment. When the file's process
 * exits, after its tests and their `after` hooks, the guard looks for:
 * - an entry still in the file's temp folder;
 * - a process, other than this one, that descends from it, or whose command
 *   line or environment names the file's temp folder.
 *
 * A detached warm server a CLI-level test started outlived the test and
 * raced its cleanup, with every test green; this makes that class red. What
 * leaked is killed and removed after it is named, so a failing file still
 * leaves nothing behind. The file's folder is gone either way.
 *
 * The same process keeps the unit suite's cost budgets (test-budgets.ts):
 * every spawn passes the work meter's watch, so a file that launches
 * Coherence's own command line more than its spawn budget, or reads
 * Coherence's own tree, fails at exit with each launch or read named by the
 * test that made it; and every test is timed between hooks on the file's
 * root, and fails past its ceiling.
 *
 * Inert in the runner's parent process (no NODE_TEST_CONTEXT), and in any
 * process a test spawns that does not itself load this module.
 */

import { execFileSync, watchSpawns } from "../lifecycle/work-meter.ts";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredBudget, decisionHeld, describeSpawnBudget, describeTreeReads, launchesOwnCli, overCeiling, readsOwnTree, SPAWN_BUDGET, testCeiling, type Charged } from "./test-budgets.ts";

/** A process the guard found alive: its pid and its command line. */
export interface LeakedProcess {
  pid: number;
  command: string;
}

/** What one test file left behind. */
export interface Leaks {
  processes: LeakedProcess[];
  folders: string[];
}

interface ProcessRow {
  pid: number;
  ppid: number;
  /** The process state: Z is a zombie, already exited and only waiting to be reaped by its parent. */
  state: string;
  command: string;
  /** The command line with the environment, where the platform shows it. */
  withEnvironment: string;
}

/**
 * What the tools a test drives keep in the temp folder for themselves, never
 * a fixture: Node's module compile cache (TypeScript turns it on), the
 * TypeScript language server's log folder, and tsserver's cancellation pipe
 * folders. Outside the guard they live on in the system temp folder by design.
 */
const TOOL_CACHES = [/^node-compile-cache$/, /^typescript-language-server\d*$/, /^[0-9a-f]{32}$/];

const GRACE_MS = 2_000;
const POLL_MS = 100;

/** Every process the user can see, with its parent and, where readable, its environment. */
function processTable(): ProcessRow[] {
  // A clean environment, so the listing process never names the folder itself.
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
  const plain = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,stat=,command="], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  const rows = new Map<number, ProcessRow>();
  for (const line of plain.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    rows.set(pid, { pid, ppid: Number(match[2]), state: match[3] ?? "", command: match[4] ?? "", withEnvironment: match[4] ?? "" });
  }
  if (process.platform === "darwin") {
    // macOS appends the environment a process started with to its command line under -E.
    const full = execFileSync("ps", ["-axwwE", "-o", "pid=,command="], { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
    for (const line of full.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      const row = match === null ? undefined : rows.get(Number(match[1]));
      if (row !== undefined) row.withEnvironment = match?.[2] ?? row.command;
    }
  } else {
    for (const row of rows.values()) {
      try {
        row.withEnvironment = `${row.command} ${readFileSync(`/proc/${row.pid}/environ`, "utf8").replaceAll("\0", " ")}`;
      } catch {
        // Another user's process, or one that already exited: its command line alone.
      }
    }
  }
  return [...rows.values()];
}

/** The processes and temp folder entries a test file left behind: `folder` is its own temp folder, `self` its own pid. */
export function findLeaks(folder: string, self: number): Leaks {
  let folders: string[] = [];
  try {
    folders = readdirSync(folder)
      .filter((name) => !TOOL_CACHES.some((cache) => cache.test(name)))
      .map((name) => join(folder, name));
  } catch {
    // The folder itself is gone: nothing can remain in it.
  }
  let real = folder;
  try {
    real = realpathSync(folder);
  } catch {
    // Gone: its own spelling is the only one.
  }
  const names = (row: ProcessRow): boolean => row.withEnvironment.includes(folder) || row.withEnvironment.includes(real);
  const table = processTable().filter((row) => !row.state.startsWith("Z"));
  const children = new Map<number, number[]>();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const descendants = new Set<number>();
  const pending = [...(children.get(self) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop() as number;
    if (descendants.has(pid)) continue;
    descendants.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  const processes = table
    .filter((row) => row.pid !== self && (descendants.has(row.pid) || names(row)))
    // The listing's own ps, started by this process with a clean environment.
    .filter((row) => !(row.ppid === self && /^ps -axww/.test(row.command)))
    .map((row) => ({ pid: row.pid, command: row.command }));
  return { processes, folders };
}

/** The report a failing file prints: one line per leaked process and per leaked folder. */
export function describeLeaks(file: string, leaks: Leaks): string {
  const lines = [`leak guard: ${file} left ${leaks.processes.length} process(es) and ${leaks.folders.length} temp folder(s) behind`];
  for (const leaked of leaks.processes) lines.push(`  process ${leaked.pid}: ${leaked.command}`);
  for (const folder of leaks.folders) lines.push(`  temp folder: ${folder}`);
  return `${lines.join("\n")}\n`;
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function install(): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "cg-"));
  process.env["TMPDIR"] = folder;
  process.env["COHERENCE_LEAK_GUARD"] = folder;
  const file = process.argv[1] ?? "a test file";

  process.on("exit", () => {
    // A process a test signalled but did not wait for may still be exiting: give it a moment.
    let leaks = findLeaks(folder, process.pid);
    for (let waited = 0; waited < GRACE_MS && leaks.processes.length + leaks.folders.length > 0; waited += POLL_MS) {
      pause(POLL_MS);
      leaks = findLeaks(folder, process.pid);
    }
    if (leaks.processes.length + leaks.folders.length > 0) {
      writeSync(2, describeLeaks(file, leaks));
      for (const leaked of leaks.processes) {
        try {
          process.kill(leaked.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      process.exitCode = 1;
    }
    rmSync(folder, { recursive: true, force: true });
  });
  await installBudgets(file);
}

/**
 * Every test timed between a beforeEach and an afterEach hook on the file's
 * root, registered here before the file's own code runs, so they wrap every
 * test the file declares, nested or not, wherever it imports node:test from,
 * and leave each test's reported file and location its own. The afterEach
 * fails a test past its ceiling: the unit suite's, or a budget the test
 * declared with budget(t, seconds, because) citing a decision.
 */
/** A test's name with its suites' (node:test's fullName), the key a declared budget is kept under. */
function fullName(t: { name: string }): string {
  return (t as { fullName?: string }).fullName ?? t.name;
}

async function timeTests(charge: { test: string }): Promise<void> {
  const { afterEach, beforeEach } = await import("node:test");
  const unit = testCeiling();
  const started = new Map<string, number>();
  beforeEach((t) => {
    charge.test = t.name;
    started.set(fullName(t), performance.now());
  });
  afterEach(async (t) => {
    const at = started.get(fullName(t));
    started.delete(fullName(t));
    if (at === undefined) return;
    const seconds = (performance.now() - at) / 1000;
    const declared = declaredBudget(fullName(t));
    if (declared !== undefined && !(await decisionHeld(declared.because))) {
      throw new Error(`time budget: "${t.name}" cites ${declared.because}, which is no decision in this repository's journal; record the decision with coherence decide and cite its id`);
    }
    if (seconds > (declared?.budget ?? unit)) throw new Error(overCeiling(t.name, seconds, unit, declared));
  });
}

/** The spawn budget and the whole-tree rule, kept at exit, and the time ceiling, kept per test (test-budgets.ts). */
async function installBudgets(file: string): Promise<void> {
  const charge = { test: "<outside any test>" };
  const launches: Charged[] = [];
  const reads: Charged[] = [];
  const e2e = file.endsWith(".e2e.ts");
  watchSpawns((spawn) => {
    const line = [spawn.file, ...spawn.args].join(" ").slice(0, 200);
    if (launchesOwnCli(spawn)) launches.push({ test: charge.test, line });
    if (!e2e && readsOwnTree(spawn)) reads.push({ test: charge.test, line });
  });
  await timeTests(charge);
  process.on("exit", () => {
    if (!e2e && launches.length > SPAWN_BUDGET) {
      writeSync(2, describeSpawnBudget(file, launches));
      process.exitCode = 1;
    }
    if (reads.length > 0) {
      writeSync(2, describeTreeReads(file, reads));
      process.exitCode = 1;
    }
  });
}

if (process.env["NODE_TEST_CONTEXT"] !== undefined) await install();
