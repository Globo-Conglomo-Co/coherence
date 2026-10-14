/**
 * cli() runs a command in the test file's own process and leaves the process
 * as it found it: the folder and the environment are back after every call,
 * a second call while one runs is refused, and nothing a module kept about a
 * project in one call answers the next (process-caches.ts). That a call
 * answers as the spawned binary does is cli.e2e.ts's.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { cli } from "./cli-fixture.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coherence-cli-fixture-")));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("cli() puts the folder and the environment back after every call, one that fails included, and refuses a second call while one runs", async () => {
  const root = project({ "coherence.config.json": JSON.stringify({ name: "back" }) });
  const folder = process.cwd();
  const before = { ...process.env };
  const ran = await cli(["version"], { cwd: root, env: { PATH: process.env["PATH"], HOME: root, COHERENCE_NO_UPDATE_CHECK: "1", ONLY_IN_THE_CALL: "1" } });
  assert.equal(ran.status, 0);
  assert.equal(process.cwd(), folder);
  assert.deepEqual({ ...process.env }, before);
  const failed = await cli(["no-such-verb"], { cwd: root, env: { PATH: process.env["PATH"], ONLY_IN_THE_CALL: "1" } });
  assert.equal(failed.status, 64);
  assert.match(failed.stderr, /unknown verb "no-such-verb"/);
  assert.equal(process.cwd(), folder);
  assert.deepEqual({ ...process.env }, before);
  const first = cli(["help"], { cwd: root });
  await assert.rejects(cli(["help"], { cwd: root }), /still running in this process/);
  assert.equal((await first).status, 0);
  await assert.rejects(cli(["hook-serve"], { cwd: root }), /spawn it, in a \*\.e2e\.ts file/);
  assert.equal(process.cwd(), folder);
});

test("cli() answers a second call as a fresh process would after the project changed under it: a folder made a repository that ignores a component", async () => {
  const root = project({
    "coherence.config.json": JSON.stringify({ name: "fresh" }),
    "src/A.spec.md": "# A\n\nThe a module.\n",
    "kept/B.spec.md": "# B\n\nThe b module.\n",
  });
  const first = await cli(["spec", "--check"], { cwd: root });
  assert.match(first.stdout, /\bB\b/, "outside git every spec is the project's");
  spawnSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "kept/\n");
  const second = await cli(["spec", "--check"], { cwd: root });
  const fresh = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "..", "cli.ts"), "spec", "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(second.stdout, fresh.stdout);
  assert.doesNotMatch(second.stdout, /\bB\b/, "in a repository an ignored folder's spec is not");
});
