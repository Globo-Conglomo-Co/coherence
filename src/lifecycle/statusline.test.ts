import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { JOURNAL_DIR } from "../journal/store.ts";
import { DEFAULT_LATENCY_BUDGET, HOOK_TIMES_DIR } from "./hook-latency.ts";
import { PRACTICES_DIR } from "./practice-delivery.ts";
import { serverPaths } from "../enforcement/server.ts";
import { readStatus, STATUS_DEFAULT_BUDGET, STATUS_SOURCES, STATUS_TOOL_HOOKS, statusText } from "./statusline.ts";
import { TOOL_HOOKS } from "./hook-events.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SESSION = "status-session";
const madeFolders: string[] = [];
after(() => {
  for (const folder of madeFolders) rmSync(folder, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "coherence-statusline-")));
  madeFolders.push(top);
  mkdirSync(join(top, ".git"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(top, path)), { recursive: true });
    writeFileSync(join(top, path), text);
  }
  return top;
}

const jsonl = (...records: object[]): string => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const time = (event: string, ms: number) => ({ at: "2026-10-08T10:00:00.000Z", event, ms });

test("the status line reads where the hooks keep the session's records, by the hooks' own names and budget", () => {
  assert.deepEqual(STATUS_SOURCES, { hookTimes: HOOK_TIMES_DIR, firings: PRACTICES_DIR, journal: JOURNAL_DIR, server: serverPaths("/p").pointer.slice("/p/".length) });
  assert.equal(STATUS_DEFAULT_BUDGET, DEFAULT_LATENCY_BUDGET);
  assert.deepEqual([...STATUS_TOOL_HOOKS], [...TOOL_HOOKS], "the status line counts the tool hooks hook-events.ts declares");
});

test("the status line names the session's tool hook time against the budget and the practices it owes, from every leaf of a registry", () => {
  const top = repository({
    "coherence.config.json": JSON.stringify({ projects: ["api", "web"], latencyBudget: 2 }),
    [`.coherence/hook-times/${SESSION}.jsonl`]: jsonl(time("SessionStart", 9000), time("PreToolUse", 500)),
    [`api/.coherence/hook-times/${SESSION}.jsonl`]: jsonl(time("PreToolUse", 2500), time("PostToolUse", 1000)),
    [`api/.coherence/practices/${SESSION}.jsonl`]: jsonl(
      { at: "2026-10-08T10:01:00.000Z", practice: "api/close a defect", version: "a", trigger: "command defect", whole: true },
      { at: "2026-10-08T10:02:00.000Z", practice: "api/oil the knob", version: "b", trigger: "edit knob.ts", whole: true },
    ),
    [`api/.coherence/journal/${SESSION}.jsonl`]: jsonl({ id: "en-1", kind: "enactment", at: "2026-10-08T10:03:00.000Z", session: SESSION, practice: "api/oil the knob" }),
    [`web/.coherence/hook-times/${SESSION}.jsonl`]: jsonl(time("PostToolUse", 1000)),
    // Another session's records are never this one's.
    [`web/.coherence/hook-times/other.jsonl`]: jsonl(time("PreToolUse", 60000)),
  });
  const reading = readStatus({ session_id: SESSION, workspace: { current_dir: join(top, "web") } });
  assert.ok(reading !== undefined);
  assert.equal(reading.calls, 4, "the session start is no tool hook");
  assert.equal(reading.totalMs, 5000);
  assert.equal(reading.over, 1, "the config's 2 s budget, not the default");
  assert.deepEqual(reading.owed, ["api/close a defect"], "a practice enacted after it fired is not owed");
  assert.equal(statusText({ ...reading, version: "9.9.9" }, false), "coherence 9.9.9 · hooks 1.3 s avg, 1 over 2 s · 1 practice owed: close a defect");
});

test("the status line is quiet outside every project and plain where nothing wants the user's eye", () => {
  const top = repository({ "notes/a.md": "A note.\n" });
  assert.equal(statusText(readStatus({ session_id: SESSION, workspace: { current_dir: join(top, "notes") } })), "");
  assert.equal(statusText(readStatus({ workspace: { current_dir: top } })), "", "no session, nothing to read");
  const quiet = repository({ "coherence.config.json": JSON.stringify({ name: "p" }), [`.coherence/hook-times/${SESSION}.jsonl`]: jsonl(time("PreToolUse", 300)) });
  assert.equal(statusText({ ...readStatus({ session_id: SESSION, cwd: quiet })!, version: "1.0.0" }, false), "coherence 1.0.0 · hooks 0.3 s avg");
});

test("the status line module imports nothing but node's own, so a render never loads the hooks' modules", () => {
  for (const file of ["statusline.ts", "../statusline.ts"]) {
    const text = readFileSync(resolve(here, file), "utf8");
    const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]!);
    assert.ok(imports.length > 0, file);
    assert.deepEqual(imports.filter((i) => !i.startsWith("node:") && i !== "./lifecycle/statusline.ts"), [], `${file} imports only node built-ins and the status line module`);
  }
});

test("the status line command prints the user's own status line first, from the same session input, then Coherence's", () => {
  const top = repository({ "coherence.config.json": JSON.stringify({ name: "p" }), [`.coherence/hook-times/${SESSION}.jsonl`]: jsonl(time("PreToolUse", 300)) });
  const input = JSON.stringify({ session_id: SESSION, workspace: { current_dir: top } });
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", resolve(here, "../statusline.ts"), "--", "cat >/dev/null; echo theirs"], { input, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^theirs\ncoherence \S+ · hooks 0\.3 s avg\n$/);
});

test("the status line links the live Scope page while its warm server answers, never as a bare address and never for a server that is gone", () => {
  const token = "ab".repeat(32);
  const ended = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const top = repository({
    "coherence.config.json": JSON.stringify({ name: "p" }),
    [`.coherence/hook-times/${SESSION}.jsonl`]: jsonl(time("PreToolUse", 300)),
    ".coherence/run/server.json": JSON.stringify({ pid: process.pid, token, http: { port: 4321 } }),
  });
  const reading = readStatus({ session_id: SESSION, cwd: top })!;
  assert.equal(reading.scope, `http://127.0.0.1:4321/?token=${token}`);
  assert.ok(statusText(reading, false, true).endsWith(`\u001b]8;;http://127.0.0.1:4321/?token=${token}\u001b\\scope ↗\u001b]8;;\u001b\\`), "a terminal hyperlink whose label alone shows");
  assert.ok(!statusText(reading, false, false).includes(token), "without links, no address at all: it carries the token");
  writeFileSync(join(top, ".coherence/run/server.json"), JSON.stringify({ pid: ended, token, http: { port: 4321 } }));
  assert.equal(readStatus({ session_id: SESSION, cwd: top })!.scope, undefined, "a server that is gone answers nothing");
  writeFileSync(join(top, ".coherence/run/server.json"), JSON.stringify({ pid: process.pid, token }));
  assert.equal(readStatus({ session_id: SESSION, cwd: top })!.scope, undefined, "a server that serves no HTTP yet has no page");
});
