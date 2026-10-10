/**
 * Enforcement over a small plain-JavaScript project (ES modules, `.mjs`,
 * a `jsconfig.json` with `allowJs`) written into a temporary folder: the
 * same protected symbol, chokepoint, inside reference, bypass and test
 * reference as the TypeScript fixture. Before the adapter admitted
 * JavaScript sources it walked none of these files, opened none, and the
 * first `workspace/symbol` query died with "No Project"; a `.mjs` file
 * opened as "typescript" then failed every references query with
 * "Could not find file". Here the classification, the grades and the
 * automatic refutation (whose synthetic documents must share the module's
 * extension, or the project never sees them) are pinned on JavaScript.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { TypeScriptAdapter, locateServer } from "../adapters/typescript.ts";
import { checkChokepoint, classifySite } from "./check.ts";
import { readEnforcementConfig } from "./config.ts";

const JSCONFIG = `{ "compilerOptions": { "allowJs": true, "checkJs": false, "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "noEmit": true }, "include": ["src/**/*.mjs"] }`;

const SECRETS = `/** The protected thing. */
export const SECRET_COLUMNS = { tokens: ["token"] };

const HIDDEN = new Set(["x"]);

export function seal(pattern, row) {
  const out = { ...row };
  for (const column of SECRET_COLUMNS[pattern] ?? []) delete out[column];
  return out;
}

export function peek(pattern) {
  return HIDDEN.size + pattern.length;
}
`;

const RENDER_CLEAN = `import { seal } from "../store/secrets.mjs";

export function render(pattern, row) {
  return JSON.stringify(seal(pattern, row));
}
`;

const RENDER_BYPASS = `import { SECRET_COLUMNS, seal } from "../store/secrets.mjs";

export function render(pattern, row) {
  const sealed = seal(pattern, row);
  const leaked = SECRET_COLUMNS[pattern];
  return JSON.stringify({ sealed, leaked });
}
`;

const TEST_FILE = `import { SECRET_COLUMNS } from "../store/secrets.mjs";
export const t = SECRET_COLUMNS;
`;

const CONFIG = JSON.stringify({ language: "typescript", testDir: "__tests__" });

let root: string;
let adapter: TypeScriptAdapter;
const hint = { component: ".", testFolders: readEnforcementConfig("/nowhere").testFolders };
const serverPresent = locateServer(process.cwd()).found;

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "coherence-javascript-"));
  write("jsconfig.json", JSCONFIG);
  write("coherence.config.json", CONFIG);
  write("src/store/secrets.mjs", SECRETS);
  write("src/api/render.mjs", RENDER_BYPASS);
  write("src/__tests__/secrets.test.mjs", TEST_FILE);
  adapter = new TypeScriptAdapter(root);
});

after(async () => {
  await adapter.close();
  rmSync(root, { recursive: true, force: true });
});

test("the language server binary is found (the adapter's precondition)", () => {
  assert.ok(serverPresent, "typescript-language-server must be installed: npm install");
});

test("a plain-JavaScript project is walked, its symbols resolve, and every site is classified as in the TypeScript fixture", async () => {
  const protectedThing = (await adapter.resolve("SECRET_COLUMNS", hint)) as { ok: true; definition: import("../adapters/adapter.ts").Definition };
  const chokepoint = (await adapter.resolve("seal", hint)) as { ok: true; definition: import("../adapters/adapter.ts").Definition };
  assert.ok(protectedThing.ok, "the protected thing resolves in a .mjs module");
  assert.ok(chokepoint.ok, "the chokepoint resolves in a .mjs module");
  assert.equal(protectedThing.definition.file, "src/store/secrets.mjs");
  const sites = await adapter.references(protectedThing.definition);
  const classes = sites.map((s) => `${s.file}:${s.line} ${classifySite(s, protectedThing.definition, chokepoint.definition, hint.testFolders)}`);
  assert.deepEqual(classes, [
    "src/__tests__/secrets.test.mjs:1 test",
    "src/__tests__/secrets.test.mjs:2 test",
    "src/api/render.mjs:1 bypass",
    "src/api/render.mjs:5 bypass",
    "src/store/secrets.mjs:8 inside",
  ]);
});

test("grades on JavaScript: broken with a bypass, then a pass once the bypass is gone; the automatic refutation stages .mjs documents the project can see", async () => {
  const broken = await checkChokepoint(adapter, { protects: "SECRET_COLUMNS", chokepoint: "seal", ...hint, root });
  assert.equal(broken.grade, "broken", broken.reason);
  assert.equal(broken.verdict, "fail");
  assert.deepEqual(broken.bypasses, [
    { file: "src/api/render.mjs", line: 1, symbol: "module top level" },
    { file: "src/api/render.mjs", line: 5, symbol: "render.leaked" },
  ]);
  assert.equal(broken.counts.test, 2, "a test reference is reported, never a bypass");
  assert.equal(broken.refutation, "automatic", "both staged sites were seen, so the check is not vacuous on JavaScript");

  write("src/api/render.mjs", RENDER_CLEAN);
  await adapter.forget();
  const clean = await checkChokepoint(adapter, { protects: "SECRET_COLUMNS", chokepoint: "seal", ...hint, root });
  assert.equal(clean.verdict, "pass", clean.reason);
  assert.equal(clean.refutation, "automatic");
  assert.match(clean.reason, /2 test references/);

  // A thing its module does not export. With `checkJs` off the compiler publishes no diagnostic for a JavaScript
  // import of an unexported name, so the top rung's refutation cannot be witnessed: the check says so and stays
  // "not run", never a pass claimed from a diagnostic that never came. (A project with `checkJs` gets the refusal.)
  const hidden = await checkChokepoint(adapter, { protects: "HIDDEN", chokepoint: "peek", ...hint, root });
  assert.equal(hidden.grade, "visibility-choked", hidden.reason);
  assert.equal(hidden.verdict, "not run", hidden.reason);
  assert.match(hidden.reason, /coherence-refutation-[0-9a-f]+\.mjs importing HIDDEN drew no diagnostic from the compiler/, "the account names the .mjs synthetic and the missing diagnostic");
});
