/**
 * The scale benchmark: the real hook sequence of one session, through the
 * command line, over the synthetic monorepo generate.ts writes. Each event
 * is a fresh `node src/cli.ts hook <event>` process, as a host runs it, and
 * its wall time is what the session waits. The warm-up stays on
 * (COHERENCE_NO_WARM_UP unset), since warming is part of the real cost, and
 * every process the session started, warm servers and language servers
 * among them, is stopped at the end.
 *
 * Each event's time is held to a budget in budgets.json, set a few times
 * above what GitHub's runners measured, so the benchmark catches an
 * order-of-magnitude regression and not noise. A tool hook's budget never
 * exceeds a multiple of the latency budget (3 s) either. On ubuntu-latest
 * (2026-10-07) an event above the products or outside them took about
 * 0.5 s, a tool hook inside a product 4.0 to 5.3 s (over the 3 s latency
 * budget), and the prompt after the change and the stop 4.2 to 5.0 s.
 *
 * usage: node bench/scale/run.ts [--keep] [--json <file>]
 * With GITHUB_STEP_SUMMARY set, the timings go to the job summary too.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generate, LEAVES } from "./generate.ts";
import { TOOL_HOOKS } from "../../src/lifecycle/hook-events.ts";
import { DEFAULT_LATENCY_BUDGET } from "../../src/lifecycle/hook-latency.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const BUDGETS = fileURLToPath(new URL("./budgets.json", import.meta.url));
/** The latency budget a tool hook is held to, in seconds, and the most a tool hook's budget here may be as a multiple of it. */
const LATENCY_BUDGET_S = DEFAULT_LATENCY_BUDGET;
const TOOL_MARGIN = 4;

interface Step {
  label: string;
  event: string;
  input: Record<string, unknown>;
  /** What the tool did between its PreToolUse and its PostToolUse. */
  act?: () => void;
}

interface Timing {
  label: string;
  event: string;
  ms: number;
  exit: number | null;
  budgetMs: number;
}

const { values } = parseArgs({ options: { keep: { type: "boolean", default: false }, json: { type: "string" } } });

const root = realpathSync(mkdtempSync(join(tmpdir(), "coherence-scale-")));
const session = `bench-${process.pid}-${Date.now().toString(36)}`;
const made = generate(root);
process.stdout.write(`generated ${made.files} files, ${made.lines} lines, ${LEAVES.length} products in ${root}\n`);

const budgets = JSON.parse(readFileSync(BUDGETS, "utf8")) as Record<string, number>;
// Every process the session starts carries this in its environment, so the cleanup finds it however it was detached.
const MARK = `COHERENCE_SCALE_BENCH=${session}`;
const env: Record<string, string | undefined> = { ...process.env, COHERENCE_SCALE_BENCH: session, CLAUDE_PROJECT_DIR: root };
delete env["COHERENCE_NO_WARM_UP"];
delete env["NODE_TEST_CONTEXT"];

const base = { session_id: session, cwd: root, transcript_path: join(root, ".bench-transcript.jsonl") };
const at = (path: string): string => join(root, path);
const replace = (path: string, from: string, to: string) => (): void => {
  const text = readFileSync(at(path), "utf8");
  if (!text.includes(from)) throw new Error(`${path} lacks ${from}`);
  writeFileSync(at(path), text.replace(from, to));
};

function tool(label: string, name: string, input: Record<string, unknown>, act?: () => void): Step[] {
  return [
    { label: `${label} (PreToolUse)`, event: "PreToolUse", input: { ...base, hook_event_name: "PreToolUse", tool_name: name, tool_input: input } },
    { label: `${label} (PostToolUse)`, event: "PostToolUse", input: { ...base, hook_event_name: "PostToolUse", tool_name: name, tool_input: input, tool_response: { success: true } }, ...(act === undefined ? {} : { act }) },
  ];
}

function edit(label: string, path: string, from: string, to: string): Step[] {
  const [pre, post] = tool(label, "Edit", { file_path: at(path), old_string: from, new_string: to }, replace(path, from, to));
  return [pre!, post!];
}

const steps: Step[] = [
  { label: "SessionStart", event: "SessionStart", input: { ...base, hook_event_name: "SessionStart", source: "startup" } },
  { label: "UserPromptSubmit", event: "UserPromptSubmit", input: { ...base, hook_event_name: "UserPromptSubmit", prompt: "Tighten the pipeline steps in each product." } },
  ...tool("read", "Read", { file_path: at("products/alpha/backend/pkg_3/module_4.py") }),
  ...edit("edit alpha (Python)", "products/alpha/backend/pkg_3/module_4.py", "total = upstream(value) +", "total = upstream(value) - 1 +"),
  ...edit("edit beta (TypeScript)", "products/beta/frontend/src/feature_2/component_7.ts", "let total = upstream(value) +", "let total = upstream(value) - 1 +"),
  ...edit("edit gamma (store)", "products/gamma/backend/store/reader.py", "return door()[0]", "return door()[-1]"),
  ...edit("edit outside every product", "posthog/shared_3/module_2.py", "total = upstream(value) +", "total = upstream(value) - 1 +"),
  ...tool("cd into alpha", "Bash", { command: "cd products/alpha && ls" }),
  { label: "UserPromptSubmit after the change", event: "UserPromptSubmit", input: { ...base, hook_event_name: "UserPromptSubmit", prompt: "Now check the store still reads through the door." } },
  { label: "Stop", event: "Stop", input: { ...base, hook_event_name: "Stop", stop_hook_active: false } },
];

/** The pids of every live process carrying the session's mark, but this one. */
function marked(): number[] {
  const pids: number[] = [];
  if (process.platform === "darwin") {
    const table = execFileSync("ps", ["-axwwE", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    for (const line of table.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match !== null && match[2]!.includes(MARK)) pids.push(Number(match[1]));
    }
  } else {
    for (const line of execFileSync("ps", ["-e", "-o", "pid="], { encoding: "utf8" }).split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(MARK)) pids.push(pid);
      } catch {
        // Another user's, or gone.
      }
    }
  }
  return pids.filter((pid) => pid !== process.pid);
}

async function stopEverything(): Promise<number> {
  const pids = marked();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Gone already.
    }
  }
  const deadline = Date.now() + 10_000;
  while (marked().length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const pid of marked()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone between the listing and the signal.
    }
  }
  return pids.length;
}

const timings: Timing[] = [];
let failure: string | undefined;
try {
  for (const step of steps) {
    step.act?.();
    const started = performance.now();
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "hook", step.event], { cwd: root, env, input: JSON.stringify(step.input), encoding: "utf8", timeout: 120_000 });
    const ms = Math.round(performance.now() - started);
    const budgetMs = budgets[step.label];
    if (budgetMs === undefined) throw new Error(`budgets.json names no budget for "${step.label}"`);
    timings.push({ label: step.label, event: step.event, ms, exit: result.status, budgetMs });
    if (result.status !== 0 && result.status !== 2) failure ??= `${step.label} exited ${result.status}: ${result.stderr.trim().slice(0, 400)}`;
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  const stopped = await stopEverything();
  process.stdout.write(`stopped ${stopped} background process(es) the session started\n`);
  if (!values.keep) rmSync(root, { recursive: true, force: true });
}

const over = timings.filter((t) => t.ms > t.budgetMs);
const tooLoose = timings.filter((t) => TOOL_HOOKS.has(t.event) && t.budgetMs > LATENCY_BUDGET_S * 1000 * TOOL_MARGIN);
const toolMs = timings.filter((t) => TOOL_HOOKS.has(t.event)).map((t) => t.ms);
const rows = timings.map((t) => `| ${t.label} | ${t.event} | ${t.ms} | ${t.budgetMs} | ${t.ms > t.budgetMs ? "over" : "ok"} |`);
const summary = [
  "## Scale benchmark: one session's hooks",
  "",
  `${made.files} files, ${made.lines} lines, ${LEAVES.length} products under a registry. Warm-up on; times are each hook process's wall time.`,
  "",
  "| step | event | ms | budget ms | |",
  "|---|---|---:|---:|---|",
  ...rows,
  "",
  `Tool hooks: slowest ${Math.max(...toolMs, 0)} ms, total ${toolMs.reduce((a, b) => a + b, 0)} ms over ${toolMs.length} calls; the latency budget is ${LATENCY_BUDGET_S} s.`,
  "",
].join("\n");
process.stdout.write(`\n${summary}`);
if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], summary);
if (values.json !== undefined) writeFileSync(values.json, `${JSON.stringify({ files: made.files, lines: made.lines, timings }, null, 2)}\n`);

const problems = [
  ...(failure === undefined ? [] : [failure]),
  ...over.map((t) => `${t.label}: ${t.ms} ms, over its ${t.budgetMs} ms budget`),
  ...tooLoose.map((t) => `${t.label}: its budget of ${t.budgetMs} ms is above ${TOOL_MARGIN} x the ${LATENCY_BUDGET_S} s latency budget`),
];
if (problems.length > 0) {
  process.stderr.write(`\nscale benchmark failed:\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
  process.exit(1);
}
