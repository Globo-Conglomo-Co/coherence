/**
 * The warm hook process against the per-event hook, interleaved: each round
 * runs one session of the same events through `coherence hook <event>` (a
 * process per event, as a settings hook spawns it) and one through a single
 * `coherence hook-serve --socket` (as the Claude Code mod reaches it), the
 * order alternating by round. Times are wall clock at the caller, so the
 * per-event figure includes Node's start for the CLI and the socket round trip
 * for the warm process.
 *
 *   node bench/hook-serve/run.ts <project root> <rounds> <fixture|posthog> <out.json>
 *
 * Sessions are named spike-<arm>-<round>; the caller removes what they record.
 */

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "src", "cli.ts");
const NODE = [process.execPath, "--disable-warning=ExperimentalWarning", CLI];

type Step = { label: string; event: string; input: Record<string, unknown> };

function steps(root: string, kind: string, session: string): Step[] {
  const base = { cwd: root, session_id: session };
  const edit = (path: string, text: string) => ({ ...base, tool_name: "Edit", tool_input: { file_path: join(root, path), old_string: "zzz-never", new_string: text }, tool_use_id: `t-${path}-${text.length}` });
  const read = (path: string) => ({ ...base, tool_name: "Read", tool_input: { file_path: join(root, path) }, tool_use_id: `r-${path}` });
  const pair = (label: string, input: Record<string, unknown>): Step[] => [
    { label: `${label} (pre)`, event: "PreToolUse", input: { ...input, hook_event_name: "PreToolUse" } },
    { label: `${label} (post)`, event: "PostToolUse", input: { ...input, hook_event_name: "PostToolUse", tool_response: {} } },
  ];
  const [first, outside] = kind === "posthog" ? ["posthog/auth.py", "frontend/src/scenes/App.tsx"] : ["src/a.ts", "outside/b.ts"];
  const added = kind === "posthog" ? "def authenticate(self, request):" : "export const b = 2;";
  return [
    { label: "session start", event: "SessionStart", input: { ...base, hook_event_name: "SessionStart", source: "startup" } },
    { label: "prompt", event: "UserPromptSubmit", input: { ...base, hook_event_name: "UserPromptSubmit", prompt: "harden auth" } },
    ...pair("first edit", edit(first!, added)),
    ...pair("repeat edit", edit(first!, "x = 1")),
    ...pair("edit outside every leaf", edit(outside!, "const a = 1")),
    { label: "read (post)", event: "PostToolUse", input: { ...read(first!), hook_event_name: "PostToolUse", tool_response: {} } },
    { label: "stop", event: "Stop", input: { ...base, hook_event_name: "Stop", stop_hook_active: false } },
  ];
}

function env(root: string): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_PROJECT_DIR: root, COHERENCE_TELEMETRY: "0", COHERENCE_NO_UPDATE_CHECK: "1" };
}

async function viaCli(root: string, step: Step): Promise<{ wall: number; exit: number | null; bytes: number }> {
  const began = performance.now();
  const ran = spawnSync(NODE[0]!, [...NODE.slice(1), "hook", step.event], { cwd: root, input: JSON.stringify(step.input), encoding: "utf8", env: env(root) });
  return { wall: performance.now() - began, exit: ran.status, bytes: ran.stdout.length };
}

function post(socket: string, body: string): Promise<string> {
  return new Promise((done, fail) => {
    const req = request({ socketPath: socket, method: "POST", path: "/hook" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", fail);
    req.end(body);
  });
}

async function warmSession(root: string, list: Step[]): Promise<{ start: number; rows: { label: string; wall: number; served: number; exit: number; bytes: number }[] }> {
  const began = performance.now();
  const child = spawn(NODE[0]!, [...NODE.slice(1), "hook-serve", "--socket"], { cwd: root, env: env(root), stdio: ["ignore", "pipe", "inherit"] });
  const first = await new Promise<string>((done) => createInterface({ input: child.stdout }).once("line", done));
  const start = performance.now() - began;
  const socket = (JSON.parse(first) as { ready: { socket: string } }).ready.socket;
  const rows = [];
  let id = 0;
  for (const step of list) {
    const t = performance.now();
    const answer = JSON.parse(await post(socket, JSON.stringify({ id: ++id, op: "hook", event: step.event, input: step.input }))) as { exit: number; ms: number; stdout: string };
    rows.push({ label: step.label, wall: performance.now() - t, served: answer.ms, exit: answer.exit, bytes: answer.stdout.length });
  }
  const exited = new Promise((done) => child.on("exit", done));
  child.kill("SIGTERM");
  await exited;
  return { start, rows };
}

async function main(): Promise<void> {
  const [rootArg, roundsArg, kind = "fixture", out] = process.argv.slice(2);
  const root = resolve(rootArg!);
  const rounds = Number(roundsArg ?? 3);
  const power = spawnSync("pmset", ["-g"], { encoding: "utf8" }).stdout;
  const battery = spawnSync("pmset", ["-g", "batt"], { encoding: "utf8" }).stdout;
  const results: unknown[] = [];
  for (let round = 1; round <= rounds; round++) {
    const order = round % 2 === 1 ? ["cli", "warm"] : ["warm", "cli"];
    for (const arm of order) {
      const session = `spike-${arm}-${kind}-${round}-${Date.now()}`;
      const list = steps(root, kind, session);
      if (arm === "cli") {
        const rows = [];
        for (const step of list) rows.push({ label: step.label, ...(await viaCli(root, step)) });
        results.push({ round, arm, session, rows });
      } else {
        results.push({ round, arm, session, ...(await warmSession(root, list)) });
      }
      process.stderr.write(`round ${round} ${arm} done\n`);
    }
  }
  const after = spawnSync("pmset", ["-g", "batt"], { encoding: "utf8" }).stdout;
  writeFileSync(out!, JSON.stringify({ root, kind, rounds, power, battery, after, results }, null, 2));
}

await main();
