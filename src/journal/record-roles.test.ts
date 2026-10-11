import assert from "node:assert/strict";
import { test } from "node:test";
import { recordStrings } from "../lifecycle/check.ts";
import { recordProse } from "../lifecycle/lexicon-coverage.ts";
import { RECORD_ROLES, type NestedRoles, type RoleTable, type WordRole } from "./record.ts";

interface Marked {
  value: Record<string, unknown>;
  /** Each marker string the record holds, with the role its field was given. */
  roles: Map<string, WordRole>;
}

/** A record holding, in every field a table names, a string that names the field, nested as its role says; and one field no table names. */
function marked(prefix: string, table: RoleTable, roles = new Map<string, WordRole>()): Marked {
  const value: Record<string, unknown> = {};
  for (const [field, role] of Object.entries(table)) {
    const marker = `${prefix}.${field}`;
    if (typeof role === "string") {
      value[field] = marker;
      roles.set(marker, role);
    } else value[field] = nested(marker, role, roles);
  }
  return { value, roles };
}

function nested(marker: string, role: NestedRoles, roles: Map<string, WordRole>): unknown {
  if ("fields" in role) return marked(marker, role.fields, roles).value;
  return [marked(`${marker}[0]`, role.each, roles).value, marked(`${marker}[1]`, role.each, roles).value];
}

test("both readers of a record's words read every field by the role its record type declares, and a field no type declares as prose", () => {
  for (const [kind, table] of Object.entries(RECORD_ROLES)) {
    const { value, roles } = marked(kind, table);
    value["kind"] = kind;
    roles.set(kind, "meta");
    value["undeclared"] = `${kind}.undeclared`;
    roles.set(`${kind}.undeclared`, "prose");
    const want = (read: (role: WordRole) => boolean): string[] => [...roles].filter(([, role]) => read(role)).map(([marker]) => marker).sort();

    const checked: string[] = [];
    recordStrings(value, checked);
    assert.deepEqual(checked.sort(), want((role) => role === "prose"), `the vocabulary check reads a ${kind} by a list of its own`);
    assert.deepEqual(recordProse(JSON.stringify(value)).sort(), want((role) => role !== "meta"), `lexicon coverage reads a ${kind} by a list of its own`);
  }
  // A map of outcomes is read by its values' table, whatever its keys are.
  const enactment = { kind: "enactment", id: "en-1", results: { "1": { result: "done", evidence: "the evidence" }, "2": { result: "skipped", because: "the reason" } } };
  assert.deepEqual(recordProse(JSON.stringify(enactment)).sort(), ["the evidence", "the reason"]);
  // A close's results are verdicts on step ids, never words.
  assert.deepEqual(recordProse(JSON.stringify({ kind: "close", of: "x-1", results: { a1: "pass" }, outcome: "success" })), []);
});
