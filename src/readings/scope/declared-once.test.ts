import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CANDIDATE_RULES, groupLine, RULE_PLURALS } from "./entrance-coverage.ts";
import { rulesText } from "./undeclared.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

test("every detection rule says its own plural, and a count of entrances by rule reads it there", () => {
  const rules = Object.values(CANDIDATE_RULES).flat();
  for (const { rule, plural } of rules) {
    assert.equal(RULE_PLURALS[rule], plural, `${rule}'s plural is the one its rule declares`);
    assert.equal(rulesText([{ rule }, { rule }, { rule }]), `3 ${plural}`, `three ${rule} entrances are counted as ${plural}`);
    assert.equal(rulesText([{ rule }]), `1 ${rule}`);
    assert.equal(groupLine({ component: "c", name: "g", handler: "h", covers: 2, rules: [rule] }), `"g" (h) stands for 2 ${plural}`);
  }
  // A rule seen in two languages says one plural.
  const byRule = new Map<string, Set<string>>();
  for (const { rule, plural } of rules) byRule.set(rule, (byRule.get(rule) ?? new Set()).add(plural));
  for (const [rule, plurals] of byRule) assert.equal(plurals.size, 1, `${rule} has one plural`);
  // No module keeps a table of plurals of its own.
  const source = readFileSync(join(HERE, "entrance-coverage.ts"), "utf8");
  assert.doesNotMatch(source, /RULE_PLURALS[^=]*=\s*\{/, "RULE_PLURALS is derived from the rules, not written out");
});

/** Every source module outside Scope's own folder, tests and fixtures aside. */
function toolSources(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path !== HERE && entry.name !== "node_modules") toolSources(path, into);
    } else if (/\.ts$/.test(entry.name) && !/\.(test|e2e)\.ts$/.test(entry.name) && !/fixture/.test(entry.name)) into.push(path);
  }
  return into;
}

/**
 * The string-literal unions and `as const` string lists a text writes, each
 * as its sorted members. Comments are left out, and so is a union passed to
 * Omit, Pick, Exclude or Extract, which names members of another type: a
 * selection, not a list.
 */
function literalSets(source: string): string[][] {
  const text = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
    .replace(/\b(?:Omit|Pick|Exclude|Extract)<[^<>]*?,\s*"[^"\n]+"(?:\s*\|\s*"[^"\n]+")*\s*>/g, "");
  const unions = [...text.matchAll(/"[^"\n]+"(?:\s*\|\s*"[^"\n]+")+/g)].map((m) => [...m[0].matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
  const lists = [...text.matchAll(/\[\s*("[^"\n]+"(?:\s*,\s*"[^"\n]+")+)\s*\]\s*as const/g)].map((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
  return [...unions, ...lists].map((s) => [...new Set(s)].sort()).filter((s) => s.length >= 2);
}

test("Scope's page model and views write no closed list the tool's own modules declare; each is imported as a type", () => {
  const declared = new Map<string, string>();
  for (const file of toolSources(join(REPO, "src"))) {
    for (const set of literalSets(readFileSync(file, "utf8"))) declared.set(set.join("|"), relative(REPO, file));
  }
  for (const file of readdirSync(HERE).filter((f) => /\.ts$/.test(f) && !/test|fixture/.test(f))) {
    for (const set of literalSets(readFileSync(join(HERE, file), "utf8"))) {
      const home = declared.get(set.join("|"));
      assert.equal(home, undefined, `${file} writes ${set.join(" | ")} out by hand; ${home} declares it, so import its type`);
    }
  }
});
