/**
 * The warm hook process answers as the per-event hook does: the same output
 * and the same records for the same events; it says when its code went stale
 * rather than answer from old code; and over its socket it is gone, folder and
 * all, once its host ends it, which a client reads as a process to replace.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { stopWarmServers } from "../enforcement/server-fixture.ts";
import { hookServer, type ServeAnswer } from "./hook-serve.ts";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
const made: string[] = [];
after(async () => {
  // A stop starts the project's warm server through the enforcement door, on both paths: it goes before its fixture does.
  for (const dir of made) await stopWarmServers(dir);
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** The environment both paths run under: no warm-up, telemetry or update check, and no host project naming another folder. */
function quietEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, COHERENCE_NO_WARM_UP: "1", COHERENCE_TELEMETRY: "0", COHERENCE_NO_UPDATE_CHECK: "1" };
  delete env["CLAUDE_PROJECT_DIR"];
  return env;
}

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coherence-hook-serve-")));
  made.push(root);
  const files: Record<string, string> = {
    "coherence.config.json": JSON.stringify({ name: "serve" }),
    "src/a.ts": "export const a = 1;\n",
    "src/A.spec.md": "# A\n\nThe a module.\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return root;
}

/** A session's events, as the host would send them for a project at `root`. */
function events(root: string): { event: string; input: Record<string, unknown> }[] {
  const base = { cwd: root, session_id: "spike-parity" };
  const edit = { ...base, tool_name: "Edit", tool_input: { file_path: join(root, "src/a.ts"), old_string: "1", new_string: "2" }, tool_use_id: "t1" };
  return [
    { event: "SessionStart", input: { ...base, hook_event_name: "SessionStart", source: "startup" } },
    { event: "UserPromptSubmit", input: { ...base, hook_event_name: "UserPromptSubmit", prompt: "change a" } },
    { event: "PreToolUse", input: { ...edit, hook_event_name: "PreToolUse" } },
    { event: "PostToolUse", input: { ...edit, hook_event_name: "PostToolUse", tool_response: {} } },
    { event: "PostToolUse", input: { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(root, "src/a.ts") }, tool_use_id: "t2", tool_response: {} } },
    { event: "Stop", input: { ...base, hook_event_name: "Stop", stop_hook_active: false } },
  ];
}

/** Every file Coherence keeps under the project's .coherence, relative, sorted. */
function records(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(root, path));
    }
  };
  walk(join(root, ".coherence"));
  return out.sort();
}

function hookTimeEvents(root: string): string[] {
  return readFileSync(join(root, ".coherence", "hook-times", "spike-parity.jsonl"), "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
}

test("the warm process answers a session's events with the per-event hook's output and keeps the same records", async () => {
  const cold = project();
  const warm = project();
  const viaCli = events(cold).map(({ event, input }) => {
    const ran = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "hook", event], { cwd: cold, input: JSON.stringify(input), encoding: "utf8", env: quietEnv() });
    return { stdout: ran.stdout.replaceAll(cold, "<root>"), stderr: ran.stderr.replaceAll(cold, "<root>"), exit: ran.status };
  });

  const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "hook-serve"], { cwd: warm, env: quietEnv(), stdio: ["pipe", "pipe", "inherit"] });
  const answers: ServeAnswer[] = [];
  const lines = createInterface({ input: server.stdout });
  const done = new Promise<void>((resolveDone) => lines.on("close", resolveDone));
  lines.on("line", (line) => answers.push(JSON.parse(line) as ServeAnswer));
  events(warm).forEach(({ event, input }, id) => server.stdin.write(`${JSON.stringify({ id, op: "hook", event, input })}\n`));
  server.stdin.end();
  await done;
  const viaServe = answers.map((a) => {
    assert.ok("stdout" in a, `an answer, not ${JSON.stringify(a)}`);
    return { stdout: a.stdout.replaceAll(warm, "<root>"), stderr: a.stderr.replaceAll(warm, "<root>"), exit: a.exit };
  });

  assert.deepEqual(answers.map((a) => a.id), [0, 1, 2, 3, 4, 5], "one answer per request, in order");
  assert.deepEqual(viaServe, viaCli);
  assert.ok(viaCli[0]!.stdout.includes("additionalContext"), "the sample includes a start that says something");
  assert.deepEqual(records(warm), records(cold));
  assert.deepEqual(hookTimeEvents(warm), hookTimeEvents(cold));
});

test("a warm process whose code changed on disk answers stale and runs nothing, so its client runs the event through the command line", async () => {
  const root = project();
  let code = "one";
  const server = hookServer(root, { fingerprint: () => code });
  const said: ServeAnswer[] = [];
  const write = async (answer: ServeAnswer): Promise<void> => void said.push(answer);
  assert.deepEqual(await server.serve({ id: 1, op: "ping" }, write), { exit: false });
  code = "two";
  assert.deepEqual(await server.serve({ id: 2, event: "SessionStart", input: { cwd: root, session_id: "spike-stale" } }, write), { exit: true });
  assert.ok("pong" in said[0]!);
  assert.ok("stale" in said[1]! && /changed on disk/.test(said[1].stale));
  assert.equal(existsSync(join(root, ".coherence", "hook-times")), false, "no event ran");
});

test("over its socket the warm process answers until its host ends it, and is then gone with its folder, which a client reads as a process to replace", async () => {
  const root = project();
  const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "hook-serve", "--socket"], { cwd: root, env: quietEnv(), stdio: ["ignore", "pipe", "inherit"] });
  const first = await new Promise<string>((resolveLine) => createInterface({ input: server.stdout }).once("line", resolveLine));
  const socket = (JSON.parse(first) as { ready: { socket: string } }).ready.socket;
  const post = (body: object): Promise<string> =>
    new Promise((resolvePost, reject) => {
      const req = request({ socketPath: socket, method: "POST", path: "/hook" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolvePost(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  const pong = JSON.parse(await post({ id: 7, op: "ping" })) as ServeAnswer;
  assert.equal(pong.id, 7);
  assert.ok("pong" in pong && pong.pong.pid === server.pid);
  const exited = new Promise<number | null>((resolveExit) => server.on("exit", resolveExit));
  server.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.equal(existsSync(dirname(socket)), false, "the socket's private folder is removed");
  await assert.rejects(post({ id: 8, op: "ping" }), /ENOENT|ECONNREFUSED/);
});
