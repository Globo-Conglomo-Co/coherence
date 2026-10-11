import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { ATTRIBUTE_LINES, IGNORE_TEXT } from "../lifecycle/state-files.ts";
import { storeOf } from "../readings/scope/live.ts";
import { PROSE_STORE_FOLDERS, STORES, STORE_FOLDERS, STORE_NAMES, storeDir, storeOfPath } from "./stores.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const fixtures: string[] = [];

after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  const run = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stdout}${run.stderr}`);
}

/** Every source file Coherence runs, tests and fixtures aside, and the CI scripts. */
function sources(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "fonts") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, into);
    else if (/\.(ts|mjs)$/.test(entry.name) && !/\.(test|e2e)\.ts$/.test(entry.name) && !/fixture/.test(entry.name)) into.push(path);
  }
  return into;
}

/** The spellings by which a module would name a store's folder again: a path under .coherence, or two store folders listed or alternated together. */
function secondNamings(text: string): string[] {
  const folder = STORE_FOLDERS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const patterns = [
    new RegExp(`["'\`]\\.coherence["'\`]\\s*,\\s*["'\`](?:${folder})["'\`]`, "g"),
    new RegExp(`\\.coherence(?:/|\\\\\\\\?/)(?:${folder})(?:/|\\\\\\\\?/)["'\`]`, "g"),
    new RegExp(`["'\`](?:${folder})["'\`]\\s*,\\s*["'\`](?:${folder})["'\`]`, "g"),
    new RegExp(`\\((?:${folder})(?:\\|(?:${folder}))+\\)`, "g"),
  ];
  const code = text
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  return patterns.flatMap((p) => [...code.matchAll(p)].map((m) => m[0]));
}

test("every record store is committed, merged by union, followed live, read for words when it holds prose, and summarized from the one table, and no module names a store's folder again", () => {
  for (const store of STORE_NAMES) {
    const folder = STORES[store].folder;
    assert.equal(storeDir(store), join(".coherence", folder));
    assert.ok(IGNORE_TEXT.split("\n").includes(`!/${folder}/`), `${store} is not kept by .coherence/.gitignore, so it would never be committed`);
    assert.ok(ATTRIBUTE_LINES.includes(`${folder}/*.jsonl merge=union`), `${store} has no union merge in .coherence/.gitattributes`);
    assert.equal(storeOf(join(".coherence", folder, "s.jsonl"), []), store, `Scope live does not follow ${store}`);
    assert.equal(storeOfPath(`.coherence/${folder}/s.jsonl`), store);
    assert.equal(PROSE_STORE_FOLDERS.includes(folder), STORES[store].prose);
  }

  // The CI summary, run as CI runs it, counts a record added to each store.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coherence-stores-")));
  fixtures.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  for (const store of STORE_NAMES) {
    mkdirSync(join(root, storeDir(store)), { recursive: true });
    writeFileSync(join(root, storeDir(store), "s.jsonl"), `${JSON.stringify({ id: `${store}-1`, kind: `${store}-kind` })}\n`);
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "records");
  const summary = spawnSync(process.execPath, [join(REPO, ".github", "scripts", "records-summary.mjs"), "HEAD~1", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, new RegExp(`\\b${STORE_NAMES.length} records\\b`), summary.stdout);

  // No second list: every module takes a store's folder from the table.
  const found: string[] = [];
  for (const file of [...sources(join(REPO, "src")), ...sources(join(REPO, ".github", "scripts"))]) {
    if (file === join(REPO, "src", "journal", "stores.ts")) continue;
    // The status line imports nothing but node's own, so it spells the journal's folder itself; statusline.test.ts holds it equal to JOURNAL_DIR, which is the table's.
    if (file === join(REPO, "src", "lifecycle", "statusline.ts")) continue;
    for (const naming of secondNamings(readFileSync(file, "utf8"))) found.push(`${relative(REPO, file)}: ${naming}`);
  }
  assert.deepEqual(found, [], "a module names a record store's folder itself instead of importing it from journal/stores.ts");
});

test("a store's folder spelled as a second list is found wherever a module writes it", () => {
  assert.deepEqual(secondNamings(`export const RECORD_STORES = ["journal", "runs", "work"];`).length, 1);
  assert.deepEqual(secondNamings(`const RECORD_FOLDERS = ["journal", "work"];`).length, 1);
  assert.deepEqual(secondNamings(`const RUNS_DIR = join(".coherence", "runs");`).length, 1);
  assert.deepEqual(secondNamings(`  if (name.startsWith(".coherence/work/")) return "work";`).length, 1);
  assert.deepEqual(secondNamings("area = /^\\+\\+\\+ b\\/\\.coherence\\/(journal|runs|work)\\//.exec(line)"), ["(journal|runs|work)"]);
  assert.deepEqual(secondNamings(` * One JSONL file per session under .coherence/journal/ and "journal", "work".`), []);
  assert.deepEqual(secondNamings(`const RUN_FILES = storeDir("runs");`), []);
});
