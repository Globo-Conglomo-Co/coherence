/**
 * The prefilter over Coherence's own tree: the reading asked through the word
 * index equals the reading that asks every declaration. The unit suite proves
 * the prefilter on fixtures, one per escape hatch; this is the same
 * comparison on a real project, run in the bench job because it reads the
 * whole tree twice and so costs more with every merge.
 *
 * usage: node bench/interfaces/own-tree.ts
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeScriptAdapter } from "../../src/adapters/typescript.ts";
import { bothWays, sameMap } from "../../src/readings/scope/both-ways.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const started = performance.now();
const own = await bothWays(new TypeScriptAdapter(root), root);
if (own.filtered.kind === "unread") {
  console.error(`no TypeScript instrument for Coherence's tree: ${own.filtered.because}`);
  process.exit(1);
}
sameMap(own.exhaustive, own.filtered, "Coherence's own tree");
const symbols = own.filtered.kind === "read" ? own.filtered.symbols.length : 0;
if (symbols <= 100) {
  console.error(`a real map, not an empty one: ${symbols} symbols`);
  process.exit(1);
}
console.log(`the prefilter hides nothing on Coherence's own tree: ${symbols} symbols, both ways, in ${((performance.now() - started) / 1000).toFixed(1)} s`);
