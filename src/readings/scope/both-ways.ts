/**
 * The prefilter's comparison, shared by its unit test (the fixtures, one per
 * escape hatch) and the bench job (Coherence's own tree, whose reading grows
 * with every merge and so stays out of the unit suite): one project read
 * exhaustively and through the prefilter, and the two maps compared.
 */

import assert from "node:assert/strict";
import type { LanguageAdapter } from "../../adapters/adapter.ts";
import { readComponentInterfaces } from "./component-interfaces.ts";
import type { InterfaceReading } from "./model.ts";

/** Read a project exhaustively and through the prefilter on one server; both readings, and the server closed. */
export async function bothWays(adapter: LanguageAdapter, root: string): Promise<{ exhaustive: InterfaceReading; filtered: InterfaceReading }> {
  try {
    // Neither keeps answers: the filtered reading must ask the server itself for what the prefilter lets through.
    const exhaustive = await readComponentInterfaces(root, adapter, { exhaustive: true, keep: false });
    const filtered = await readComponentInterfaces(root, adapter, { keep: false });
    return { exhaustive, filtered };
  } finally {
    await adapter.close();
  }
}

export function sameMap(exhaustive: InterfaceReading, filtered: InterfaceReading, what: string): void {
  assert.equal(filtered.kind, "read", what);
  assert.equal(exhaustive.kind, "read", what);
  if (filtered.kind !== "read" || exhaustive.kind !== "read") return;
  assert.deepEqual(filtered.symbols, exhaustive.symbols, `${what}: the same component interfaces, symbols and site counts`);
  assert.deepEqual(filtered.entrances, exhaustive.entrances, `${what}: the same entrances and reaches`);
  assert.equal(filtered.declarations, exhaustive.declarations, what);
  assert.deepEqual(filtered.unowned, exhaustive.unowned, what);
}
