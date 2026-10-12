import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { HOST_FOLDER } from "../lifecycle/hosts.ts";
import { entranceName } from "../scaffold/entrances.ts";
import { NEXT_ROUTE_METHODS, REMIX_ROUTE_EXPORTS } from "./entrance-candidates.ts";
import { CONCATENATED, OWN_KEYS, SETUP_KEYS, TEST_KEYS } from "./project-config.ts";
import { exclusionOf, walkBounds } from "./project-files.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The keys a docs table's first cell names: "`testDir` / `testDirs`" is testDir and testDir. */
function keysIn(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

/** The rows of the Markdown table under a heading, as cells. */
function tableUnder(markdown: string, heading: string): string[][] {
  const at = markdown.indexOf(heading);
  assert.ok(at >= 0, `docs/config.md has the heading ${heading}`);
  const rows: string[][] = [];
  for (const line of markdown.slice(at).split("\n").slice(1)) {
    const row = line.trim();
    if (row.startsWith("#")) break;
    if (!row.startsWith("|")) {
      if (rows.length > 0) break;
      continue;
    }
    if (/^\|[-| ]+\|$/.test(row)) continue;
    rows.push(row.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim()));
  }
  return rows.slice(1);
}

/** Every source module Coherence runs, tests and fixtures aside. */
function sources(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "fonts") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, into);
    else if (/\.(ts|mjs)$/.test(entry.name) && !/\.(test|e2e)\.ts$/.test(entry.name) && !/fixture/.test(entry.name)) into.push(path);
  }
  return into;
}

const sorted = (values: Iterable<string>): string[] => [...values].sort();

test("the config's key groups, the hosts' folders and the route exports are each declared once, and docs/config.md's tables name exactly the keys the code reads", () => {
  const config = readFileSync(join(REPO, "docs", "config.md"), "utf8");

  // The inheritance rules, key by key, against the groups the registry merge reads.
  const rules = tableUnder(config, "The rules, key by key:");
  const ruleOf = (pattern: RegExp): string[] => rules.filter((r) => pattern.test(r[1] ?? "")).flatMap((r) => keysIn(r[0]!));
  assert.deepEqual(sorted(ruleOf(/^Never inherited/)), sorted(OWN_KEYS), "the never-inherited row names OWN_KEYS");
  assert.deepEqual(sorted(ruleOf(/^Combined/)), sorted(CONCATENATED), "the combined rows name CONCATENATED");
  assert.deepEqual(sorted(ruleOf(/^One group/)), sorted(TEST_KEYS), "the one-group row names TEST_KEYS");

  // The tests table names every setup key, and tests is the setups' own key, documented below it.
  const testsTable = tableUnder(config, "## Tests: how a totality oracle is run").flatMap((r) => keysIn(r[0]!));
  assert.deepEqual(sorted(testsTable), sorted(SETUP_KEYS), "the tests table names exactly the setup keys");
  assert.deepEqual(sorted(TEST_KEYS), sorted(["tests", ...SETUP_KEYS]));
  const perSetup = /Each test setup takes the keys of the table\s+above \(([^)]+)\)/.exec(config)?.[1] ?? "";
  assert.deepEqual(sorted(keysIn(perSetup)), sorted(SETUP_KEYS), "the per-setup sentence names exactly the setup keys");

  // A test setup is read through the setup keys alone.
  const reader = readFileSync(join(REPO, "src", "enforcement", "config.ts"), "utf8");
  const setupReader = reader.slice(reader.indexOf("function testSetupOf"), reader.indexOf("export function readEnforcementConfig"));
  const read = new Set([...setupReader.matchAll(/record\["([A-Za-z]+)"\]/g)].map((m) => m[1]!));
  assert.deepEqual(sorted(read), sorted(SETUP_KEYS), "testSetupOf reads every setup key and no other");

  // Every host's folder is left out of the walk as a host's, never read for words.
  const root = mkdtempSync(join(tmpdir(), "coherence-host-folders-"));
  try {
    for (const folder of Object.values(HOST_FOLDER)) assert.equal(exclusionOf(`${folder}/notes.md`, walkBounds(root, [], { readHidden: true })), `host folder: ${folder}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // A scaffolded entrance names a route by the method or loader export detection found it by.
  for (const method of NEXT_ROUTE_METHODS) assert.equal(entranceName({ file: "app/api/users/route.ts", symbol: method, rule: "route handler" }), `${method} api/users/route`);
  for (const name of REMIX_ROUTE_EXPORTS) assert.equal(entranceName({ file: "app/routes/users.tsx", symbol: name, rule: "route handler" }), `${name} users`);

  // No other module writes the route exports or the host folders out again.
  const methods = [...NEXT_ROUTE_METHODS].map((m) => `["'\`]${m}["'\`]`).join("\\s*,\\s*");
  for (const file of sources(join(REPO, "src"))) {
    const at = relative(REPO, file);
    const code = readFileSync(file, "utf8");
    if (at !== "src/adapters/entrance-candidates.ts") assert.doesNotMatch(code, new RegExp(methods), `${at} writes the route methods out by hand`);
    if (at !== "src/lifecycle/hosts.ts") for (const folder of Object.values(HOST_FOLDER)) assert.doesNotMatch(code, new RegExp(`["']\\${folder}["'/]`), `${at} names ${folder} by hand`);
  }
});
