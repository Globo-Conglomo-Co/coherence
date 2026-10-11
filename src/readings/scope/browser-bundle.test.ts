/**
 * The browser bundle is derived, never listed: every module the page's entry
 * imports at run time, followed to the end. A module the page calls into
 * cannot be left out (1.6.0 to 1.7.1 shipped a page whose Structure view
 * called languagesReadLine, defined in a module no list named, so the live
 * page waited on "Connecting…" forever), and an import the browser cannot
 * resolve inside the bundle fails the build. And the page shows its own
 * failures: a drawing that throws is put on the page, never kept as a
 * connection reason nothing shows.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { BROWSER_ENTRY, browserSources, buildShell } from "./build.ts";

/** A reader over in-memory sources, already stripped as the build strips them. */
const reader = (files: Record<string, string>) => async (name: string): Promise<string> => {
  const text = files[name];
  if (text === undefined) throw new Error(`no source ${name}`);
  return text;
};

test("the browser bundle is every module the entry imports at run time, dependencies first, and an import the browser cannot resolve fails the build", async () => {
  const files = {
    [BROWSER_ENTRY]: 'import { view } from "./view.ts";\nimport "./effects.ts";\nexport function boot() { view(); }\n',
    "view.ts": 'import { line } from "../../spec/line.ts";\nexport function view() { return line(); }\n',
    "../../spec/line.ts": "export function line() { return 1; }\n",
    "effects.ts": "globalThis.loaded = true;\n",
    // Type stripping leaves an empty list where every name was a type: no edge, so this module is never read.
    "unread.ts": "export const x = 1;\n",
  };
  files["view.ts"] = 'import { } from "./unread.ts";\n' + files["view.ts"];
  assert.deepEqual(await browserSources(reader(files)), ["../../spec/line.ts", "view.ts", "effects.ts", BROWSER_ENTRY], "followed to the end, each module after what it imports");

  const refused = async (statement: string, why: RegExp) => {
    const bad = { ...files, "view.ts": `${statement}\nexport function view() {}\n` };
    await assert.rejects(browserSources(reader(bad)), why, statement);
  };
  await refused('import { readFileSync } from "node:fs";', /view\.ts imports node:fs at run time, and the page runs in a browser/);
  await refused('import { marked } from "marked";', /view\.ts imports marked at run time/);
  await refused('import { line as l } from "../../spec/line.ts";', /never renamed, as a namespace or as a default/);
  await refused('import * as lines from "../../spec/line.ts";', /never renamed, as a namespace or as a default/);
  await refused('import line from "../../spec/line.ts";', /never renamed, as a namespace or as a default/);
});

test("the real page's bundle includes every module its sources call into, the one 1.7.1 left out among them", async () => {
  const sources = await browserSources();
  assert.equal(sources.at(-1), BROWSER_ENTRY, "the entry comes last");
  assert.ok(sources.includes("languages-read.ts"), "structure-flow.ts calls languagesReadLine, so its module is joined");
  assert.ok(sources.indexOf("languages-read.ts") < sources.indexOf("structure-flow.ts"), "before the module that calls it");
});

test("a page whose drawing throws shows the failure where the reader sees it, never a waiting line forever", async () => {
  const { html } = await buildShell();
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script !== undefined, "the shell carries its module");
  // A fake DOM just deep enough to boot, fetch the first load and start drawing; the drawing then throws on what it lacks.
  let banner: { innerHTML: string } | undefined;
  const root = {
    innerHTML: "",
    querySelector(selector: string) {
      if (selector === "[data-failure]") return banner ?? null;
      if (selector === ".connection-waiting") return root.innerHTML.includes("connection-waiting") ? { remove: () => (root.innerHTML = "") } : null;
      return null;
    },
    prepend(element: { innerHTML: string }) {
      banner = element;
    },
  };
  const element = () => ({ className: "", innerHTML: "", setAttribute() {} });
  const state = { lexicon: { layers: [] }, spec: {}, runs: { records: [] }, journal: { records: [] } };
  const context = {
    document: { getElementById: (id: string) => (id === "scope-root" ? root : null), createElement: element, querySelector: () => null },
    location: { search: "?token=t", hash: "" },
    URLSearchParams,
    addEventListener() {},
    // The page's own timers (retries, watchdogs) never hold the test open: a page that keeps waiting fails the assertion below instead of hanging.
    setTimeout: (run: () => void, ms?: number) => setTimeout(run, ms).unref(),
    clearTimeout,
    console,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ state, version: "v", history: {} }) }),
  };
  // One module in the browser; a script here, so the module's export keywords go.
  runInNewContext(script.replace(/^export \{\};?$/gm, "").replace(/^export /gm, ""), context);
  for (let i = 0; i < 50 && banner === undefined; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(banner !== undefined, `the failure is on the page; the page shows: ${root.innerHTML.slice(0, 160)}`);
  assert.match(banner.innerHTML, /Scope could not draw this reading\./);
  assert.doesNotMatch(root.innerHTML, /Connecting to the warm server/, "the waiting line is gone");
});
