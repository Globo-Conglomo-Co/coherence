/**
 * The Scope check: builds the reading and asserts what the page must hold.
 *
 *   npm run scope:check
 */

import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DEFAULTS, STATE_SLOT, buildScopePage, buildShell, scopeState, snapshotOf, windowState, writeStructurePreview, type BuildOptions } from "./build.ts";
import { makeFixture, type Fixture } from "./check-fixture.ts";
import { CITED_WINDOW, SITE_WINDOW, componentOfFile, sitesLeftCount, windowJournal, windowRuns, allReliance, componentId, defectsOf, flowChokepointId, invariantId, journalId, latestOf, relianceId, resolveHash, runId, structureId, verifiedOf, workId } from "./derive.ts";
import { escapeHtml } from "./html.ts";
import type { Lexicon, LexiconCoverage, PageEntry, RecordedSite, RunRecord, ShellState, SiteTally, StructurePreview, WorkOrder } from "./model.ts";
import { renderShell, renderView } from "./shell.ts";
import { flowOf } from "./structure-flow.ts";
import { mergeSites } from "./updates.ts";

/**
 * Coherence's lexicon over the fixture's tree. The page over Coherence's own
 * tree (its size, every record embedded or counted, the site window over its
 * own runs) is the bench job's (bench/scope/own-tree.ts): it reads the whole
 * tree and every record, so it costs more with every merge, and no unit test
 * reads Coherence's whole tree (enforcement/test-budgets.ts).
 */
let options: BuildOptions;

let fixture: Fixture;
let fixtureState: ShellState;

before(async () => {
  fixture = makeFixture();
  options = { root: fixture.root, lexiconPath: DEFAULTS.lexiconPath, project: DEFAULTS.project };
  ({ state: fixtureState } = await buildScopePage({ root: fixture.root, lexiconPath: DEFAULTS.lexiconPath, project: "Fixture" }));
});

after(() => fixture.remove());

/** A fresh copy of the fixture state, so a test's filters never leak into another's. */
function fresh(): ShellState {
  return JSON.parse(JSON.stringify(fixtureState)) as ShellState;
}

/** The markup of one card on a view. */
function card(rendered: string, id: string): string {
  const start = rendered.indexOf(`id="${id}"`);
  assert.ok(start !== -1, `card ${id} is on the page`);
  return rendered.slice(start, rendered.indexOf("</article>", start));
}

/** Every card id a view renders, in order. */
function cardIds(rendered: string): string[] {
  return [...rendered.matchAll(/<article class="entry[^"]*" id="([^"]+)"/g)].map((m) => m[1]!);
}

function firstLexicon(state: ShellState): Lexicon {
  const layer = state.lexicon.layers[0];
  assert.ok(layer !== undefined && layer.kind === "present", "the Coherence layer is present");
  return layer.lexicon;
}

/** The JSON the page embeds, read back out of the file. */
function embeddedState(html: string): ShellState {
  const match = /<script type="application\/json" id="scope-state">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match !== null && match[1] !== undefined, "the page embeds its state");
  return JSON.parse(match[1]) as ShellState;
}

test("a snapshot is the shell with one inline state and loads nothing from outside: no external src, href, url() or @import", async () => {
  const { html, state } = await buildScopePage(options);
  const { html: shell } = await buildShell();
  assert.equal(html.replace(/<script type="application\/json" id="scope-state">[\s\S]*?<\/script>/, STATE_SLOT), shell, "the snapshot is the shell byte for byte, its state slot filled");
  assert.deepEqual(embeddedState(html), state, "and the state it carries is the state the reading loads");
  for (const [name, page] of [["snapshot", html], ["shell", shell]] as const) {
    const attributes = [...page.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)["']/g)].map((m) => m[1] ?? "");
    for (const value of attributes) {
      assert.ok(value.startsWith("#") || value.startsWith("data:"), `${name}: external reference: ${value}`);
    }
    const style = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1] ?? "";
    assert.ok(style.length > 0, `${name}: the styles are inline`);
    assert.doesNotMatch(style, /url\(\s*["']?(?:https?:)?\/\//, `${name}: no external url() in styles`);
    assert.doesNotMatch(style, /@import/, `${name}: no @import in styles`);
    assert.doesNotMatch(page, /^\s*import\s/m, `${name}: the inline module has no import statements left`);
    // The script asks only its own origin, by path: the live page's API, never another host.
    const script = /<script type="module">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
    assert.doesNotMatch(script, /fetch\(\s*["'`]https?:/, `${name}: no fetch leaves the page's own origin`);
  }
});

test("the embedded state is the loaded lexicon, unchanged", async () => {
  const { html, state } = await buildScopePage(options);
  assert.deepEqual(embeddedState(html), state);
  const lexicon = firstLexicon(state);
  const file = JSON.parse(await readFile(DEFAULTS.lexiconPath, "utf8")) as {
    concepts: { name: string; detail?: object; provenance?: object }[];
    metaphors: Record<string, string>;
    shape: object;
    version: number;
    rejected?: object[];
    retired?: { name: string }[];
  };
  assert.equal(lexicon.concepts.length, file.concepts.length);
  assert.equal(lexicon.version, file.version);
  assert.deepEqual(Object.keys(lexicon.metaphors), Object.keys(file.metaphors));
  assert.deepEqual(lexicon.shape, file.shape, "the file's shape key is kept in the model");
  assert.deepEqual(lexicon.rejected_names, file.rejected, "the lexicon's top-level rejected names are kept whole");
  assert.deepEqual(lexicon.retired?.map((c) => c.name), file.retired?.map((c) => c.name), "every retired concept is kept");
  assert.deepEqual(lexicon.record, {}, "every top-level key of the file has a place in the model");
  for (const [i, concept] of lexicon.concepts.entries()) {
    const entry = file.concepts[i]!;
    assert.deepEqual(concept.detail, entry.detail ?? {}, `${concept.name}: detail is kept whole`);
    assert.deepEqual(concept.provenance, entry.provenance ?? {}, `${concept.name}: provenance is kept whole`);
    assert.deepEqual(concept.record, {}, `${concept.name}: every key of the entry has a place in the model`);
  }
});

test("the render shows every concept name and every rejected alternative's because", async () => {
  const { state } = await buildScopePage(options);
  const rendered = renderView(state, "lexicon").text;
  const lexicon = firstLexicon(state);
  for (const concept of lexicon.concepts) {
    assert.ok(rendered.includes(escapeHtml(concept.name)), `concept ${concept.name} is on the page`);
    for (const rejected of concept.rejected) {
      assert.ok(
        rendered.includes(escapeHtml(rejected.because)),
        `because for "${rejected.alternative}" (${concept.name}) is on the page`,
      );
    }
  }
  for (const [name, text] of Object.entries(lexicon.metaphors)) {
    assert.ok(rendered.includes(escapeHtml(text)), `metaphor ${name} is on the page`);
  }
  // The layers are where a shape key would leak; the vocabulary reading above them lists corpus paths, and one of them (docs/retired.md) is also a shape value.
  const layers = rendered.slice(rendered.indexOf('id="layer-'));
  for (const value of Object.values(lexicon.shape ?? {})) {
    if (typeof value === "string") assert.ok(!layers.includes(escapeHtml(value)), "the shape key is rendered in no lexicon layer");
  }
  assert.ok(rendered.includes(`${lexicon.concepts.length} concepts`), "concept count is in the masthead");
  assert.ok(rendered.includes(`lexicon version ${lexicon.version}`), "version is in the masthead");
  assert.ok(!rendered.includes(">Retired mechanisms</h2>"), "there is no retired-mechanisms section");
  assert.ok(!rendered.includes('class="entry retirement"'), "there are no retired-mechanism cards");
});

/** The markup of one concept's card, and the vocabulary part of it: the body above the disclosures. */
function conceptCard(rendered: string, id: string): { card: string; vocabulary: string } {
  const start = rendered.indexOf(`id="${id}"`);
  assert.ok(start !== -1, `card ${id} is on the page`);
  const card = rendered.slice(start, rendered.indexOf("</article>", start));
  const from = card.indexOf('data-section="vocabulary"');
  assert.ok(from !== -1, `card ${id} has a vocabulary section`);
  const to = card.indexOf("<details", from);
  return { card, vocabulary: card.slice(from, to === -1 ? undefined : to) };
}

test("provenance and detail are one click away; no provenance key or value appears in the vocabulary", async () => {
  const { state } = await buildScopePage(options);
  const rendered = renderView(state, "lexicon").text;
  const lexicon = firstLexicon(state);
  for (const concept of lexicon.concepts) {
    const id = `coherence-${slug(concept.name)}`;
    const { card, vocabulary } = conceptCard(rendered, id);
    assert.ok(!vocabulary.includes("<details"), `${concept.name}: the vocabulary holds no disclosure`);
    assert.ok(!vocabulary.includes('class="quotation'), `${concept.name}: no quotation in the vocabulary`);
    for (const [key, value] of Object.entries(concept.provenance)) {
      assert.ok(!vocabulary.includes(`data-field="${key}"`), `${concept.name}: provenance key ${key} is not a vocabulary field`);
      assert.ok(!vocabulary.includes(`<dt>${escapeHtml(key.replace(/_/g, " "))}</dt>`), `${concept.name}: ${key} is not labeled in the vocabulary`);
      for (const text of stringsIn(value)) {
        assert.ok(!vocabulary.includes(escapeHtml(text)), `${concept.name}: provenance ${key} text is not in the vocabulary`);
      }
    }
    const provenance = card.indexOf('data-section="provenance"');
    assert.ok(provenance !== -1 && card.includes("<summary>Provenance:"), `${concept.name}: provenance is under its own disclosure`);
    assert.ok(card.slice(provenance).includes('data-field="defined_by"'), `${concept.name}: defined_by is in provenance`);
    for (const [key, value] of Object.entries(concept.provenance)) {
      if (key === "owner_words" && typeof value === "string") {
        assert.ok(card.includes(`<blockquote class="quotation owner-words"><p>${escapeHtml(value)}</p>`), `${concept.name}: owner's words are a quotation`);
      }
      if (key === "metaphor" && typeof value === "string") {
        assert.ok(card.includes(`<blockquote class="quotation metaphor"><p>${escapeHtml(value)}</p>`), `${concept.name}: metaphor is a quotation`);
      }
    }
    const detailKeys = Object.keys(concept.detail);
    if (detailKeys.length === 0) {
      assert.ok(!card.includes('data-section="detail"'), `${concept.name}: no detail, no Detail disclosure`);
    } else {
      assert.ok(card.includes("<summary>Detail:"), `${concept.name}: detail is under its own disclosure`);
      for (const key of detailKeys) {
        assert.ok(card.includes(`data-field="${key}"`), `${concept.name}: detail ${key} is on the card`);
      }
      assert.ok(card.indexOf('data-section="detail"') < provenance, `${concept.name}: Detail comes before Provenance`);
    }
    assert.ok(!card.includes("data-section=\"record\""), `${concept.name}: the record is empty, so no record section renders`);
  }
});

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Every string inside a value, however nested. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

test("the render has one view strip with the seven views in order", async () => {
  const { state } = await buildScopePage(options);
  const rendered = renderShell(state).text;
  const tabs = [...rendered.matchAll(/role="tab"[^>]*data-view="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["structure", "lexicon", "components", "invariants", "practices", "runs", "journal"]);
  for (const label of ["Structure", "Lexicon", "Components", "Invariants", "Practices", "Runs", "Journal"]) {
    assert.ok(rendered.includes(`>${label}</button>`), `${label} tab`);
  }
});

test("Structure is the first view: the strip leads with Structure then Lexicon, and a page whose address names no view opens on it", () => {
  const state = fresh();
  assert.deepEqual(state.views.map((v) => v.id), ["structure", "lexicon", "components", "invariants", "practices", "runs", "journal"], "Structure, then Lexicon, then the rest in their order");
  assert.equal(state.activeView, state.views[0]!.id, "the state opens on the first view");
  assert.equal(state.activeView, "structure");
  const rendered = renderShell(state).text;
  const first = /<button[^>]*role="tab"[^>]*data-view="([^"]+)"[^>]*aria-selected="([a-z]+)"[^>]*tabindex="(-?\d)"/.exec(rendered);
  assert.deepEqual(first?.slice(1), ["structure", "true", "0"], "the first tab is the selected one and the one keyboard focus reaches");
  assert.equal(resolveHash(state, ""), undefined, "an address with no hash names no view, so the state's own view stands");
  for (const view of state.views) assert.deepEqual(resolveHash(state, `#${view.id}`), { view: view.id, id: undefined }, `#${view.id} still opens ${view.id}`);
});

/** The page's head on one view, with the only difference a view may make (which tab is selected) taken out. */
function headOf(rendered: string): string {
  const head = /<div class="shell">\s*<header class="shell-head">[^]*?<\/header>\s*<main class="[^"]*"/.exec(rendered);
  assert.ok(head !== null, "the page has one head before its view");
  return head[0].replace(/aria-selected="(true|false)"/g, "aria-selected").replace(/tabindex="-?\d"/g, "tabindex");
}

/** Every rule of a style sheet as selector and declarations, @media and @supports blocks flattened. */
function rulesOf(css: string): { selector: string; body: string }[] {
  const text = css.replace(/\/\*[^]*?\*\//g, "");
  return [...text.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}

test("the masthead does not move between views: its markup is the same on every view but for the selected tab, and no style sizes or places the frame by view", async () => {
  const state = fresh();
  const heads = state.views.map((view) => ({ view: view.id, head: headOf(renderView(state, view.id).text) }));
  for (const { view, head } of heads) assert.equal(head, heads[0]!.head, `the head on ${view} is the head on ${heads[0]!.view}`);

  // The frame is html, body, the shell and everything in its head. A rule that sizes or places any of it must not
  // depend on the view: no :has() on what a view renders, no view id, and the selected tab paints but never moves.
  const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
  const frame = /(^|[\s>+~,])(html|body|\.shell|\.shell-head|\.masthead|\.views|\.reading-name|\.connection)(?![-\w])/;
  const byView = /:has\(|#view-|\[data-view|\.flow-|\.view-|\.view(?![-\w])|\.structure-results/;
  const paint = new Set(["color", "border-color", "border-bottom-color", "background", "background-color", "text-decoration-color", "outline-color"]);
  let frameRules = 0;
  for (const rule of rulesOf(css)) {
    for (const selector of rule.selector.split(",").map((s) => s.trim())) {
      if (!frame.test(` ${selector}`)) continue;
      frameRules += 1;
      assert.doesNotMatch(selector, byView, `the frame rule "${selector}" depends on no view`);
      if (/aria-selected="true"|\[aria-selected\]/.test(selector)) {
        const properties = [...rule.body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]!);
        for (const property of properties) assert.ok(paint.has(property), `the selected tab only paints: "${selector}" sets ${property}`);
      }
    }
  }
  assert.ok(frameRules > 10, `the frame's rules were read (${frameRules})`);
  assert.match(css, /\nhtml \{[^}]*scrollbar-gutter: stable;/, "a view too short to scroll keeps the scrollbar's gutter");
});

test("the search derives its matches from state and hides the rest", async () => {
  const { state } = await buildScopePage(options);
  const total = firstLexicon(state).concepts.length;
  state.lexicon.query = "chokepoint";
  const rendered = renderView(state, "lexicon").text;
  const shown = [...rendered.matchAll(/class="entry concept"/g)].length;
  assert.ok(shown > 0 && shown < total, `query narrows ${total} concepts to ${shown}`);
  assert.ok(rendered.includes(`${shown} of ${total} concepts match “chokepoint”.`));
  state.lexicon.query = "no concept says this sentence";
  assert.ok(renderView(state, "lexicon").text.includes("No concept matches"));
});

test("the Scope lexicon reading displays every applicable property meaning without choosing an owner", () => {
  const state = fresh();
  const coverage: LexiconCoverage = {
    version: 1,
    projectLexicon: "lexicon.json",
    fingerprint: "ambiguous-meaning",
    population: { files: [], excluded: [], unreadable: [], extraction: "fixture", limits: [] },
    totals: { terms: 1, uses: 1, known: 1, rejected: 0, unresolved: 0, unreviewedContexts: 1 },
    terms: [{
      term: "unit basis",
      state: "declared",
      concept: null,
      layer: null,
      definition: null,
      properties: {},
      confusables: [],
      meaningAlternatives: [
        { concept: "exposure", layer: "project", definition: "The amount subject to loss.", properties: { unit_basis: "percentage" }, confusables: ["allocation"] },
        { concept: "allocation", layer: "project", definition: "The amount assigned to a strategy.", properties: { unit_basis: "percentage" }, confusables: ["exposure"] },
      ],
      fingerprint: "unit-basis",
      count: 1,
      contexts: [{ component: "money", fingerprint: "money-unit-basis", disposition: "unreviewed", because: null }],
      uses: [{ file: "src/money.ts", line: 4, component: "money", text: "unit_basis", kind: "code", fingerprint: "unit-basis-use" }],
    }],
  };
  state.lexicon.coverage = coverage;
  state.lexicon.query = "unit basis";
  const rendered = renderView(state, "lexicon").text;
  assert.match(rendered, /2 applicable property meanings; this spelling alone does not select an owner/);
  assert.match(rendered, /exposure[\s\S]*The amount subject to loss/);
  assert.match(rendered, /allocation[\s\S]*The amount assigned to a strategy/);
  assert.match(rendered, /unit_basis/);
  assert.doesNotMatch(rendered, /No settled definition/);
});

test("an absent domain lexicon is rendered as a placeholder, a present one as a second layer", async () => {
  const absent = await buildScopePage(options);
  const absentRendered = renderView(absent.state, "lexicon").text;
  assert.ok(absentRendered.includes("No domain lexicon is present."));

  const present = await buildScopePage({ ...options, domainPath: DEFAULTS.lexiconPath, domainTitle: "Stand-in domain" });
  const presentRendered = renderView(present.state, "lexicon").text;
  assert.ok(!presentRendered.includes("No domain lexicon is present."));
  assert.ok(presentRendered.includes("Stand-in domain"));
  assert.equal([...presentRendered.matchAll(/class="layer"/g)].length, 2);
  assert.ok(presentRendered.includes('id="domain-invariant"'), "domain layer cards carry their own ids");
});

test("the project's vocabulary comes first and Coherence's terms follow in a section of their own, titled as Coherence's whatever the project is called", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coherence-widgetry-"));
  const domainPath = join(dir, "lexicon.json");
  writeFileSync(domainPath, JSON.stringify({ version: 7, project: "widgetry", concepts: [{ name: "widget", definition: "A thing with a knob." }] }));
  const { state } = await buildScopePage({ ...options, project: "Widgetry", domainPath });
  await rm(dir, { recursive: true, force: true });
  const rendered = renderView(state, "lexicon").text;
  const layers = [...rendered.matchAll(/id="layer-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(layers, ["domain", "coherence"], "the project's layer first, Coherence's after");
  const section = rendered.indexOf('<section class="coherence-terms"');
  assert.ok(section > rendered.indexOf('id="layer-domain"') && section < rendered.indexOf('id="layer-coherence"'), "Coherence's layer sits inside its own section, after the project's");
  assert.match(rendered, /<h2 class="coherence-terms-heading"[^>]*>Coherence's terms<\/h2>/);
  assert.equal(state.lexicon.layers.find((l) => l.id === "coherence")?.title, "Coherence lexicon", "Coherence's layer is never titled with the project's name");
  const domain = state.lexicon.layers.find((l) => l.id === "domain");
  assert.ok(domain?.kind === "present");
  assert.match(renderShell(state).text, /1 concept, lexicon version 7/, "the masthead counts the project's lexicon, not Coherence's");

  const absent = renderView((await buildScopePage({ ...options, project: "Widgetry" })).state, "lexicon").text;
  assert.ok(absent.indexOf("No domain lexicon is present.") < absent.indexOf('<section class="coherence-terms"'), "with no project lexicon, the note that says so comes before Coherence's terms");
});

test("related names that resolve become links; the rest are marked unresolved", async () => {
  const { state } = await buildScopePage(options);
  const rendered = renderView(state, "lexicon").text;
  assert.ok(rendered.includes('href="#coherence-invariant"'));
  assert.ok(rendered.includes('class="unresolved"'), "some related names are not concepts and say so");
});

test("the shell's bytes are independent of project content; the same state in renders the same page out", async () => {
  const shell = (await buildShell()).html;
  assert.equal((await buildShell()).html, shell, "the shell builds identically twice");
  assert.ok(shell.includes(STATE_SLOT), "the shell carries an empty state slot");
  assert.doesNotMatch(shell, /<title>[^<]*Coherence/, "the shell's title names no project");

  // Every input the state depends on, named. Appending to any of them changes the state and leaves the shell alone.
  // Its own copy of the fixture: this test appends to every record store, and the shared one must not move.
  const own = makeFixture();
  const fixtureOptions: BuildOptions = { root: own.root, lexiconPath: DEFAULTS.lexiconPath, project: "Fixture" };
  const same = async (): Promise<ShellState> => {
    const first = await scopeState(fixtureOptions);
    const second = await scopeState(fixtureOptions);
    assert.deepEqual(second, first, "the same inputs load the same state");
    assert.equal(renderShell(second).text, renderShell(first).text, "the same state renders the same page");
    assert.equal(snapshotOf(shell, second), snapshotOf(shell, first), "and the same snapshot bytes");
    return first;
  };
  let previous = await same();
  for (const id of [...own.names.journalIds, own.names.session, own.names.workOrder]) assert.ok(!shell.includes(id), `the shell carries none of the project's records: ${id}`);
  const inputs: { name: string; write: () => void }[] = [
    { name: "the journal", write: () => appendFileSync(join(own.root, ".coherence", "journal", `${own.names.session}.jsonl`), JSON.stringify({ id: "d-00009999", kind: "decision", at: "2026-09-12T10:00:00.000Z", session: own.names.session, agent: "fixture", commit: "abc1234", dirty: false, chose: "one more door", over: ["two doors"], because: "a later record must reach the page" }) + "\n") },
    { name: "the runs", write: () => appendFileSync(join(own.root, ".coherence", "runs", `${own.names.session}.jsonl`), JSON.stringify({ at: "2026-09-12T10:00:00.000Z", session: own.names.session, agent: "fixture", commit: "abc1234", dirty: false, instrument: { language: "typescript", server: "cold" }, latency: 1, invariants: [{ component: "src/store", name: "single writer", form: "chokepoint", grade: "reference-choked", verdict: "pass", refutation: "automatic", bypasses: [], testReferences: 0, files: ["src/store/write.ts"], latency: 1, reason: "clean again" }] }) + "\n") },
    { name: "the work store", write: () => appendFileSync(join(own.root, ".coherence", "work", `${own.names.session}.jsonl`), JSON.stringify({ id: "wm-00009999", kind: "move", at: "2026-09-12T10:00:00.000Z", session: own.names.session, agent: "fixture", commit: "abc1234", dirty: false, of: own.names.workOrder, state: "waiting", because: "a later record must reach the page" }) + "\n") },
    { name: "the specs", write: () => appendFileSync(join(own.root, "src", "api", "Api.spec.md"), "- one more: The api keeps one rule of its own.\n  because: a later bullet must reach the page\n") },
  ];
  for (const input of inputs) {
    input.write();
    const after = await same();
    assert.notDeepEqual(after, previous, `${input.name} is an input the state depends on`);
    assert.equal((await buildShell()).html, shell, `${input.name} changed, and the shell did not`);
    previous = after;
  }
  // Another project entirely: the same shell.
  const other = await scopeState(options);
  assert.notEqual(other.project, previous.project);
  assert.equal((await buildShell()).html, shell, "a second project reads through the same shell");
  own.remove();
});

test("the state stores no copy of what it derives: the latest verdicts live in the run records and nowhere else", async () => {
  const { state } = await buildScopePage({ root: fixture.root, lexiconPath: DEFAULTS.lexiconPath, project: "Fixture" });
  for (const component of state.spec.components) {
    for (const invariant of component.invariants) {
      for (const key of ["latest", "verified", "defects"]) {
        assert.ok(!(key in invariant), `${component.folder}/${invariant.name} carries no stored ${key}: it is derived from state.runs.records at render`);
      }
    }
  }
  // Derived at render, and the same answer the stored copy used to give.
  const invariant = state.spec.components.find((c) => c.folder === "src/store")!.invariants.find((i) => i.name === "single writer")!;
  const latest = latestOf(invariant, state.runs.records);
  assert.deepEqual(latest.map((l) => [l.form, l.verdict, l.at]), [["chokepoint", "fail", fixture.names.runAts[1]]]);
  assert.deepEqual(defectsOf(invariant, state.runs.records).map((d) => d.verdict), ["fail"]);
  assert.deepEqual(verifiedOf(invariant, state.runs.records), []);
  const kept = state.spec.components.find((c) => c.folder === "src/store")!.invariants.find((i) => i.name === fixture.names.keptName)!;
  assert.deepEqual(latestOf(kept, state.runs.records).map((l) => [l.form, l.at]), [["totality oracle", fixture.names.runAts[0]]], "an enforcement a later run skipped keeps the verdict of the last run that checked it");
  assert.deepEqual(verifiedOf(kept, state.runs.records).map((v) => v.verdict), ["pass"]);
});

test("every view renders from state: every component, invariant, run, and journal record in the fixture is on its view", () => {
  const state = fresh();
  const n = fixture.names;

  const components = renderView(state, "components").text;
  for (const folder of n.components) assert.ok(components.includes(`id="${componentId(folder)}"`), `component ${folder} has a card`);
  assert.equal([...components.matchAll(/data-slot="mass"/g)].length, n.components.length, "every component reserves its mass slot");
  assert.ok(components.includes("mass: not measured"));
  assert.ok(components.includes('data-depth="2"'), "nesting follows the folders");
  assert.ok(!components.includes("data-selected-invariants"), "no component is selected until the reader selects one");
  state.components.selected = "src/store";
  const selected = renderView(state, "components").text;
  const storeCard = card(selected, componentId("src/store"));
  assert.ok(storeCard.includes("data-selected-invariants"), "the selected component shows its invariants");
  for (const { component, name } of n.invariants.filter((i) => i.component === "src/store")) {
    assert.ok(storeCard.includes(`href="#${invariantId(component, name)}"`), `${name} is listed with a link`);
  }
  assert.ok(storeCard.includes('data-count="invariants">1 invariant<') && storeCard.includes('data-count="requirements">1 requirement<'), "counts per state");

  const invariants = renderView(state, "invariants").text;
  for (const { component, name, state: lifecycle } of n.invariants) {
    const c = card(invariants, invariantId(component, name));
    assert.ok(c.includes(`data-state="${lifecycle}"`), `${name} is a ${lifecycle}`);
  }
  assert.ok(invariants.includes("enforced by the language itself"), "the ladder's top rung names its enforcer");
  assert.ok(invariants.includes('data-refutation="witnessed"') && invariants.includes('data-refutation="automatic"') && invariants.includes('data-refutation="missing"'), "all three refutation states render");
  assert.ok(invariants.includes("outside</span> → <span class=\"level\" title=\"The store&#39;s own code.\">inside"), "a crossing names its trust levels with their meanings");
  assert.ok(card(invariants, invariantId("src/store", "read shape")).includes("kept from an earlier run"), "a verdict the latest run skipped is marked as kept");
  assert.ok(card(invariants, invariantId("src/store", "open one")).includes("lacks</span> enforcement, refutation, kinds"), "what a requirement lacks is said");
  state.invariants.state = "structural defect";
  assert.deepEqual(cardIds(renderView(state, "invariants").text), [invariantId("src/store", "single writer")], "the state filter narrows to the defect");
  state.invariants.state = "";
  state.invariants.component = ".";
  assert.deepEqual(cardIds(renderView(state, "invariants").text), [invariantId(".", "entry rule")], "the component filter narrows to the root");
  state.invariants.component = "";
  state.invariants.query = "row shape";
  assert.deepEqual(cardIds(renderView(state, "invariants").text), [invariantId("src/store", "read shape")], "the search narrows by sentence");
  state.invariants.query = "";

  state.structure.selected = flowChokepointId("src/store", "single writer");
  const reliance = renderView(state, "structure").text;
  assert.ok(reliance.includes('data-kind="chokepoint"') && reliance.includes("reliance unknown: run carries no sites"), "a legacy run is explicitly incomplete on the chokepoint's selection");
  assert.ok(reliance.includes('data-field="evidence"'), "the evidence boundary is said on the map");
  delete state.structure.selected;

  const relied = allReliance(state.spec.components, state.runs.records).find((reading) => reading.invariant.name === "single writer");
  assert.ok(relied !== undefined && relied.evidence.status === "unknown");
  assert.match(relied.evidence.reason, /run carries no sites/);


  const runs = renderView(state, "runs").text;
  const runIds = cardIds(runs).filter((id) => id.startsWith("run-"));
  assert.deepEqual(runIds, [...state.runs.records].reverse().map(runId), "runs are listed latest first");
  const latest = card(runs, runIds[0]!);
  assert.ok(latest.includes('data-count="pass">0 pass<') && latest.includes('data-count="fail">1 fail<') && latest.includes('data-count="not-run">0 not run<'));
  assert.ok(latest.includes("<code>def5678</code>") && latest.includes("data-dirty"), "commit and dirty flag");
  assert.ok(latest.includes('data-field="verdicts"') && latest.includes("<details"), "verdicts are one click away");
  assert.ok(latest.includes(`kept from the run at 2026-09-10 10:00`) && latest.includes(n.keptName), "the kept mark names the earlier run");
  assert.ok(latest.includes("fixture") && latest.includes("s1-fixtu"), "agent and session");

  const journal = renderView(state, "journal").text;
  for (const id of n.journalIds) assert.ok(journal.includes(`id="journal-${id}"`), `journal record ${id} has a card`);
  assert.ok(journal.includes(`id="pinned-journal-${n.openEscalation}"`), "the open escalation is pinned at the top");
  assert.ok(!journal.includes(`id="pinned-journal-${n.acknowledgedEscalation}"`), "an acknowledged escalation is not pinned");
  assert.ok(journal.indexOf('data-field="escalations"') < journal.indexOf('id="journal-heading"'), "pinned before the timeline");
  assert.ok(card(journal, `journal-${n.acknowledgedEscalation}`).includes("acknowledged by ak-00000005"), "the answer a later record gives is in the margin");
  assert.ok(journal.includes(n.decisionOver), "a decision's rejected alternative is shown");
  assert.ok(journal.includes(n.conjectureCandidate) && journal.includes("log the key at both sites"), "a conjecture's candidates and discriminating test");
  assert.ok(journal.includes(`id="${workId(n.workOrder)}"`) && journal.includes("make every write pass through one door"), "the work order renders");
  const active = card(journal, workId(n.workOrder));
  assert.ok(active.includes('data-state="active"') && active.includes("the chokepoint check passes") && active.includes("src/store"), "the order shows its current state, success, and boundary");
  assert.ok(active.includes(`<code>${n.workMove}</code>`), "the move is history under the order");
  assert.ok(!journal.includes(`id="${workId(n.workMove)}"`), "a state-change record is never a card of its own");
  assert.ok(card(journal, workId(n.completedOrder)).includes('data-state="completed"'), "a closed order shows completed");
  state.journalView.kind = "decision";
  assert.deepEqual(cardIds(renderView(state, "journal").text).filter((id) => id.startsWith("journal-")), ["journal-d-00000001"], "the kind filter narrows");
  state.journalView.kind = "";
  state.journalView.query = "language server";
  assert.deepEqual(cardIds(renderView(state, "journal").text).filter((id) => id.startsWith("journal-")), ["journal-u-00000006"], "the search narrows");
  state.journalView.query = "";
  const absent = fresh();
  absent.journal.work = { kind: "absent", because: "nothing here" };
  assert.ok(renderView(absent, "journal").text.includes("No work orders: nothing here"), "absent work orders are a rendered fact");
});

test("a structural defect renders its bypass sites and both honest options", () => {
  const state = fresh();
  const n = fixture.names;
  const c = card(renderView(state, "invariants").text, invariantId("src/store", "single writer"));
  assert.ok(c.includes('data-field="defect"'));
  assert.ok(c.includes('data-grade="broken"') && c.includes("enforced by nobody"), "the broken rung and its enforcer");
  const bypasses = c.slice(c.indexOf('data-field="bypasses"'));
  assert.ok(bypasses.includes(`<code>${n.bypass.file}:${n.bypass.line}</code>`) && bypasses.includes(`<code>${n.bypass.symbol}</code>`), "file, line, symbol");
  assert.ok(c.includes('data-option="route"') && c.includes("Route through the chokepoint") && c.includes(`<code>${n.chokepoint}</code>`), "option one");
  assert.ok(c.includes('data-option="retire"') && c.includes("Escalate a retirement") && c.includes(`href="#${relianceId("src/store", "single writer")}"`), "option two links the reliance listing");
  for (const { component, name, state: lifecycle } of n.invariants) {
    if (lifecycle === "structural defect") continue;
    assert.ok(!card(renderView(state, "invariants").text, invariantId(component, name)).includes('data-field="defect"'), `${name} shows no defect section`);
  }
});

function setSingleWriterSites(state: ShellState, sites: RecordedSite[] | undefined): void {
  const entry = state.runs.records.at(-1)?.invariants.find((candidate) => candidate.name === "single writer" && candidate.form === "chokepoint");
  assert.ok(entry !== undefined);
  if (sites === undefined) delete entry.sites;
  else entry.sites = sites;
}

/** The Structure view with one selection made: the one map's reading of it. */
function selectedOn(state: ShellState, selected: string): string {
  return renderView({ ...state, structure: { ...state.structure, selected } }, "structure").text;
}

test("a scaffold preview is drawn dashed and unverified on its component in the one map", () => {
  const state = fresh();
  const preview: StructurePreview = {
    component: "src/store",
    name: "preview writer",
    crossing: { from: "outside", to: "inside" },
    chokepoints: [{ chokepoint: "write", protects: "writeRow" }],
  };
  state.structure.preview = [preview];
  const proposed = renderView(state, "structure").text;
  assert.match(proposed, /proposed preview · preview writer/);
  assert.match(proposed, /data-proposed="true"/);
  assert.match(proposed, /class="structure-edge structure-proposed"/);
  assert.match(proposed, /Reliance unknown: a proposal has no run evidence\. This dashed edge exists only in the ephemeral preview\./);
  assert.equal(proposed, renderView(JSON.parse(JSON.stringify(state)) as ShellState, "structure").text, "the same state renders the same bytes");
});

test("reliance reads both protected and chokepoint endpoint sites, owner first, without calling a bypass a legal door reference", () => {
  const state = fresh();
  setSingleWriterSites(state, [
    { file: "src/api/door.ts", line: 7, symbol: "save", class: "chokepoint-reference", of: "chokepoint", test: false, form: "import" },
    { file: "src/api/handler.ts", line: 12, symbol: "handle", class: "bypass", of: "protected", test: false },
    { file: "src/store/write.ts", line: 4, symbol: "write", class: "inside", of: "protected", test: false },
    { file: "src/api/door.test.ts", line: 9, symbol: "test save", class: "chokepoint-reference", of: "chokepoint", test: true },
  ]);
  const reading = allReliance(state.spec.components, state.runs.records).find((candidate) => candidate.invariant.name === "single writer");
  assert.ok(reading !== undefined && reading.evidence.status === "complete");
  assert.deepEqual(reading.evidence.sites.map((site) => site.file), ["src/store/write.ts", "src/api/door.test.ts", "src/api/door.ts", "src/api/handler.ts"], "owner component is first and sites are stable");
  const rendered = selectedOn(state, flowChokepointId("src/store", "single writer"));
  assert.match(rendered, /protected thing · inside chokepoint/);
  assert.match(rendered, /chokepoint · reference \(runtime call not established\)/);
  assert.match(rendered, /protected thing · bypass \(not a legal chokepoint reference\)/);
  assert.match(rendered, /data-test="true"/);

  const protectedOnly = fresh();
  setSingleWriterSites(protectedOnly, [{ file: "src/api/handler.ts", line: 12, symbol: "handle", class: "bypass", of: "protected", test: false }]);
  assert.match(selectedOn(protectedOnly, flowChokepointId("src/store", "single writer")), /protected thing · bypass/);
  const doorOnly = fresh();
  setSingleWriterSites(doorOnly, [{ file: "src/api/door.ts", line: 7, symbol: "save", class: "chokepoint-reference", of: "chokepoint", test: false }]);
  assert.match(selectedOn(doorOnly, flowChokepointId("src/store", "single writer")), /chokepoint · reference/);
});

test("legacy site absence stays unknown while a complete empty site list confirms zero", () => {
  const legacy = fresh();
  setSingleWriterSites(legacy, undefined);
  assert.match(selectedOn(legacy, flowChokepointId("src/store", "single writer")), /reliance unknown: run carries no sites; evidence is incomplete/);

  const empty = fresh();
  setSingleWriterSites(empty, []);
  assert.match(selectedOn(empty, flowChokepointId("src/store", "single writer")), /Complete run site evidence records 0 references/);
});

test("the Structure preview bridge validates crossings, selects Structure, and writes deterministic generated pages only", async () => {
  const preview: StructurePreview = { component: "src/store", name: "preview writer", crossing: { from: "outside", to: "inside" } };
  const output = await mkdtemp(join(tmpdir(), "coherence-structure-preview-"));
  try {
    const one = join(output, "preview-one.html");
    const two = join(output, "preview-two.html");
    const first = await writeStructurePreview(fixture.root, preview, one);
    const second = await writeStructurePreview(fixture.root, preview, two);
    assert.equal(first.state.activeView, "structure");
    assert.deepEqual(first.state.structure.preview, [preview]);
    assert.equal(await readFile(one, "utf8"), await readFile(two, "utf8"));
    assert.match(await readFile(one, "utf8"), /preview writer/);
    await assert.rejects(
      writeStructurePreview(fixture.root, { ...preview, name: "bad level", crossing: { from: "missing", to: "inside" } }, join(output, "bad.html")),
      /crossing names trust level missing/,
    );
    await assert.rejects(writeStructurePreview(fixture.root, preview, join(fixture.root, "preview.html")), /outside the project root/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("the Journal view links citations both ways: each record lists what it cites and what cites it as in-page links, and a work order lists its citations and bound records", () => {
  const state = fresh();
  const journal = renderView(state, "journal").text;
  const decision = card(journal, "journal-d-00000001");
  const citedBy = decision.slice(decision.indexOf('data-field="cited-by"'));
  assert.ok(decision.includes('data-field="cited-by"'), "a cited decision lists what cites it");
  assert.ok(citedBy.includes('href="#journal-e-00000003"'), "the escalation that cites it links to its card");
  assert.ok(citedBy.includes('data-cited="wc-00000004"') && citedBy.includes('href="#work-w-00000003"'), "a work order's close that cites it links to its order's card");
  const escalation = card(journal, "journal-e-00000003");
  const cites = escalation.slice(escalation.indexOf('data-field="cites"'));
  assert.ok(cites.includes('href="#journal-d-00000001"') && cites.includes("one door for writes"), "the escalation links to the decision it cites, with its subject");
  assert.ok(cites.includes('href="#work-w-00000001"') && cites.includes("make every write pass through one door"), "and to the work order it cites, with its objective");
  assert.ok(escalation.includes('data-field="human"') && escalation.includes("the owner asked whether the rule still earns its place") && escalation.includes("as the agent attributes"), "the human's words are shown apart from the because, as the agent's attribution");
  assert.ok(card(journal, "pinned-journal-e-00000003").includes('href="#journal-d-00000001"'), "the pinned escalation shows what it is about");
  assert.ok(card(journal, "journal-u-00000006").includes('href="#journal-c-00000002"'), "unable links to the conjecture it cites");
  assert.ok(card(journal, "journal-c-00000002").includes('href="#journal-u-00000006"'), "and the conjecture links back");
  assert.ok(!card(journal, "journal-ak-00000005").includes('class="citations"'), "a record that cites nothing and nothing cites shows no citation section");
  const active = card(journal, workId("w-00000001"));
  assert.ok(active.includes('data-field="cited-by"') && active.includes('href="#journal-e-00000003"'), "a work order lists the records citing it");
  assert.ok(active.includes('data-field="bound"') && active.includes('href="#journal-d-00000001"'), "a work order lists the journal records bound to it");
  const completed = card(journal, workId("w-00000003"));
  assert.ok(completed.includes('data-field="cites"') && completed.includes('href="#journal-d-00000001"'), "a work order lists what its own records cite");
  for (const [, target] of journal.matchAll(/href="#((?:journal|work)-[^"]+)"/g)) {
    assert.ok(journal.includes(`id="${target}"`), `link #${target} lands on a card in the view`);
    assert.equal(resolveHash(state, `#${target}`)?.view, "journal", `#${target} resolves to the Journal view`);
  }
  const trimmed = fresh();
  trimmed.journal.records = trimmed.journal.records.filter((r) => r.id !== "c-00000002");
  const absent = card(renderView(trimmed, "journal").text, "journal-u-00000006");
  assert.ok(absent.includes("data-absent") && absent.includes("journal c-00000002") && !absent.includes('href="#journal-c-00000002"'), "a citation the page does not embed is an id with the command that shows it, never a dead link");
});

test("the journal window keeps what kept records and work orders cite, one hop, up to a cap", () => {
  const decision = (i: number, cites?: string[]): ShellState["journal"]["records"][number] => ({
    id: `d-${i.toString(16).padStart(8, "0")}`, kind: "decision", at: new Date(Date.UTC(2026, 8, 12) + i * 1000).toISOString(), session: "s", agent: "a", commit: null, dirty: false,
    chose: `choice ${i}`, over: [], because: "b", ...(cites === undefined ? {} : { cites }),
  });
  const id = (i: number): string => `d-${i.toString(16).padStart(8, "0")}`;
  const order: WorkOrder = { id: "w-1", objective: "o", success: "s", boundary: "b", owner: "s", state: "active", at: "2026-09-12T00:00:00.000Z", session: "s", agent: "a", history: [], cites: [id(10)] };
  const records = Array.from({ length: 400 }, (_, i) => decision(i, i === 399 ? [id(5)] : undefined));
  const window = windowJournal(records, 150, [order]);
  const kept = new Set(window.records.map((r) => r.id));
  assert.ok(kept.has(id(5)), "an old record a kept record cites is kept");
  assert.ok(kept.has(id(10)), "an old record a work order cites is kept");
  assert.ok(!kept.has(id(6)), "an old record nothing kept cites is left out");
  assert.equal(window.omitted, 400 - 152, "what is left out is counted");
  const dense = Array.from({ length: 400 }, (_, i) => decision(i, i >= 250 ? [id(i - 250)] : undefined));
  const capped = windowJournal(dense, 150, [], CITED_WINDOW);
  assert.equal(capped.records.length, 150 + CITED_WINDOW, `citations pull in at most ${CITED_WINDOW} older records`);
  const cappedIds = new Set(capped.records.map((r) => r.id));
  assert.ok(cappedIds.has(id(149)) && cappedIds.has(id(150 - CITED_WINDOW)) && !cappedIds.has(id(149 - CITED_WINDOW)), "the latest citers are served first");
});

test("deep links resolve: every card id on every view resolves to that view", () => {
  const state = fresh();
  for (const view of state.views) {
    const rendered = renderView(state, view.id).text;
    const ids = view.id === "structure"
      ? [...rendered.matchAll(/ id="(structure--[^"]+)"/g)].map((match) => match[1]!)
      : cardIds(rendered).filter((id) => !id.startsWith("pinned-"));
    assert.ok(ids.length > 0, `${view.id} renders cards`);
    for (const id of ids) {
      const target = resolveHash(state, `#${id}`);
      assert.ok(target !== undefined && target.view === view.id && target.id === id, `#${id} resolves to ${view.id}`);
    }
    assert.deepEqual(resolveHash(state, `#${view.id}`), { view: view.id, id: undefined }, `#${view.id} names the view alone`);
  }
  assert.equal(resolveHash(state, "#nothing-here"), undefined);
  assert.equal(resolveHash(state, ""), undefined);
  const links = [...renderView(state, "invariants").text.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
  for (const link of links) assert.ok(resolveHash(state, `#${link}`) !== undefined, `link #${link} resolves`);
});

test("another project's tree builds as a second root: its lexicon is the domain layer and its run records show its structural defects", async () => {
  const other = makeFixture();
  try {
    // The domain layer's heading is the project's name, which its config gives (projectName); the lexicon stores none.
    writeFileSync(join(other.root, "coherence.config.json"), JSON.stringify({ name: "widgetry", entryDir: ".", language: "typescript" }));
    writeFileSync(join(other.root, "lexicon.json"), JSON.stringify({ version: 1, concepts: [{ name: "widget", definition: "A thing with a knob." }] }));
    const { state } = await buildScopePage({ root: other.root, lexiconPath: DEFAULTS.lexiconPath, project: "Widgetry" });
    const domain = state.lexicon.layers.find((l) => l.id === "domain");
    assert.ok(domain?.kind === "present" && domain.title === "Widgetry lexicon", "the other project's lexicon.json is located from its root");
    assert.deepEqual(state.spec.components.map((c) => c.folder).sort(), [...other.names.components].sort(), "its specs, not Coherence's, are the tree");
    assert.equal(state.runs.records.length, other.names.runAts.length, "its runs are loaded");
    const invariants = renderView(state, "invariants").text;
    const defects = state.spec.components.flatMap((c) => c.invariants.filter((i) => i.state === "structural defect"));
    assert.ok(defects.length > 0, "the fixture's run records hold a structural defect");
    assert.equal([...invariants.matchAll(/<article class="entry invariant" id="[^"]+" data-state="structural defect"/g)].length, defects.length, "every structural defect the model derives is a defect card");
    for (const defect of defects) {
      const c = card(invariants, invariantId(defect.component, defect.name));
      assert.ok(c.includes('data-option="route"') && c.includes('data-option="retire"'), `${defect.name} shows both options`);
      for (const site of defectsOf(defect, state.runs.records).flatMap((d) => d.bypasses)) {
        assert.ok(c.includes(`<code>${escapeHtml(site.file)}:${site.line}</code>`), `${defect.name} shows bypass ${site.file}:${site.line}`);
      }
    }
  } finally {
    other.remove();
  }
});

test("the first load carries at most the site window's reference sites however many chokepoints and sites the runs record, counts every site it leaves out, and derives every site count unchanged", async () => {
  const components = fixtureState.spec.components;
  // An entry's sites by the keys the window counts them by, carried and counted alike.
  const keyed = (sites: readonly RecordedSite[], left: readonly SiteTally[] = []): [string, number][] => {
    const counts = new Map<string, number>();
    const add = (key: string, n: number): void => void counts.set(key, (counts.get(key) ?? 0) + n);
    for (const s of sites) add(`${componentOfFile(s.file, components)?.folder ?? ""} ${s.of} ${s.class} ${s.test}`, 1);
    for (const t of left) add(`${t.component ?? ""} ${t.of} ${t.class} ${t.test}`, t.count);
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  };
  const files = ["src/api/handler.ts", "src/api/route.ts", "src/store/write.ts", "src/store/cache/hot.ts", "src/api/handler.test.ts", "bin/main.ts"];
  const siteAt = (i: number): RecordedSite => {
    const file = files[i % files.length]!;
    const test = file.endsWith(".test.ts");
    return { file, line: i + 1, symbol: `s${i}`, class: file.startsWith("src/store/") ? "inside" : test ? "test" : file.startsWith("bin/") ? "exempt" : "chokepoint-reference", of: i % 2 === 0 ? "chokepoint" : "protected", test };
  };
  const bypass = (i: number): RecordedSite => ({ file: "src/api/handler.ts", line: 9000 + i, symbol: "handle", class: "bypass", of: "protected", test: false });

  // However many chokepoints: the window is the page's, not each entry's.
  for (const chokepoints of [5, 60]) {
    const entries = Array.from({ length: chokepoints }, (_, c) => ({ component: "src/store", name: `door ${c}`, form: "chokepoint", grade: "reference-choked", verdict: "pass", refutation: "automatic", bypasses: [], testReferences: 0, files: [], latency: 1, reason: "r", sites: [...Array.from({ length: 400 }, (_, i) => siteAt(i)), bypass(2 * c), bypass(2 * c + 1)] }));
    const few = { ...entries[0]!, name: "small door", sites: [siteAt(1), siteAt(2), siteAt(3)] };
    const run = { at: "2026-10-01T00:00:00.000Z", session: "s-sites", agent: "a", commit: null, dirty: false, instrument: { language: "typescript", server: "warm" }, latency: 1, invariants: [...entries, few] } as unknown as RunRecord;
    const window = windowRuns([run], undefined, components);
    const carried = window.records[0]!.invariants as PageEntry[];
    const listed = carried.reduce((sum, e) => sum + e.sites!.filter((s) => s.class !== "bypass").length, 0);
    assert.ok(listed <= SITE_WINDOW, `${chokepoints} chokepoints: ${listed} sites carried, at most the window's ${SITE_WINDOW}`);
    assert.ok(listed >= SITE_WINDOW - 2 * chokepoints - chokepoints, `${chokepoints} chokepoints: the window is used, not left idle (${listed})`);
    assert.equal(carried.reduce((sum, e) => sum + e.sites!.filter((s) => s.class === "bypass").length, 0), 2 * chokepoints, "every bypass site is carried");
    carried.forEach((entry, i) => {
      const whole = run.invariants[i]!.sites!;
      assert.deepEqual(keyed(entry.sites!, entry.sitesLeft), keyed(whole), `${entry.name}: every site is carried or counted by its keys`);
      assert.equal(entry.sites!.length + sitesLeftCount(entry), whole.length);
      assert.ok(entry.sites!.every((s) => whole.includes(s)), `${entry.name}: what is carried is the run's own sites`);
    });
    assert.equal(carried.at(-1)!.sitesLeft, undefined, "an entry within its share carries every site and counts none");
    assert.equal(carried.at(-1)!.sites!.length, 3);
  }

  // Every count derived from sites is the one every site gives: map weights, bypass sites, exempt references, reliance totals.
  const whole = fresh();
  const sites = [...Array.from({ length: 2000 }, (_, i) => siteAt(i)), bypass(0)];
  setSingleWriterSites(whole, sites);
  const last = whole.runs.records.at(-1)!;
  last.invariants.find((e) => e.name === "single writer" && e.form === "chokepoint")!.from = { value: "outside bin", by: "bullet", exempt: "bin" };
  const windowed = windowState(whole);
  const writer = windowed.spec.components.flatMap((c) => c.invariants).find((i) => i.name === "single writer")!;
  const carried = latestOf(writer, windowed.runs.records).find((e) => e.form === "chokepoint")!;
  assert.ok(carried.sites!.length < sites.length && sitesLeftCount(carried) === sites.length - carried.sites!.length, "the window carries part of the sites and counts the rest");
  const weights = (state: ShellState) => flowOf(state).edges.map((edge) => [edge.id, edge.sites]);
  assert.ok(weights(whole).length > 0, "the run sites draw interfaces");
  assert.deepEqual(weights(windowed), weights(whole), "the map's reference weights are unchanged");
  assert.deepEqual(flowOf(windowed).nodes.map((n) => n.defects), flowOf(whole).nodes.map((n) => n.defects), "every bypass site is unchanged");
  const governs = (state: ShellState) => /data-field="from"[\s\S]*?<\/p>/.exec(renderView(state, "invariants").text)?.[0];
  assert.match(governs(whole) ?? "", /\d+ references from inside it exempt/);
  assert.equal(governs(windowed), governs(whole), "the exempt references are counted the same");
  const chokepoint = flowChokepointId("src/store", "single writer");
  const left = sites.length - carried.sites!.length;
  const snapshot = selectedOn(windowed, chokepoint);
  assert.ok(snapshot.includes(`${sites.length} recorded reference sites to the chokepoint or protected thing; owner component first. This page lists ${carried.sites!.length} of them.`), "the listing says how many sites there are and how many it lists");
  assert.match(snapshot, new RegExp(`data-field="sites-left" data-left="${left}">${left} more sites are counted and not listed \\([^)]*in src/api[^)]*\\): <code>query relies-on write</code> lists every one`), "a snapshot says where the rest are");
  const live = { ...windowed, connection: { mode: "live", status: "live", version: "v" } } as ShellState;
  assert.match(selectedOn(live, chokepoint), new RegExp(`data-load-sites="${last.at}~${last.session}" data-component="src/store" data-name="single writer">Load the other ${left}</button>`), "a live page offers the rest");
  assert.ok(mergeSites(live, `${last.at}~${last.session}`, "src/store", "single writer", sites), "the fetched sites replace the share");
  const loaded = selectedOn(live, chokepoint);
  assert.doesNotMatch(loaded, /data-field="sites-left"/, "and nothing is left counted");
  assert.ok(loaded.includes(`${sites.length} recorded reference sites to the chokepoint or protected thing; owner component first.</p>`));
  // The same over Coherence's own runs is the bench job's (bench/scope/own-tree.ts): it reads every run Coherence recorded.
});

test("an older run kept for the verdicts it holds carries only those, and its totals stay true on the Runs view", () => {
  const entry = (name: string, verdict: "pass" | "fail" | "not run") =>
    ({ component: "src/c", name, form: "totality-oracle", verdict, refutation: "missing", latency: 1, reason: "r" }) as unknown as RunRecord["invariants"][number];
  const run = (i: number, entries: RunRecord["invariants"]): RunRecord =>
    ({ at: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(), session: `s-${i}`, agent: "a", commit: null, dirty: false, instrument: { language: "typescript", server: "none" }, latency: 1, invariants: entries }) as unknown as RunRecord;
  // A full run of five; later runs re-check four of them, so it still holds one latest verdict (e).
  const full = run(0, [entry("a", "pass"), entry("b", "fail"), entry("c", "pass"), entry("d", "not run"), entry("e", "pass")]);
  const later = [1, 2, 3].map((i) => run(i, [entry("a", "pass"), entry("b", "pass"), entry("c", "pass"), entry("d", "pass")]));
  const records = [full, ...later];
  const window = windowRuns(records, 2);
  const kept = window.records.find((r) => r.session === "s-0");
  assert.ok(kept !== undefined, "the run holding a latest verdict is kept");
  assert.deepEqual(kept.invariants.map((e) => e.name), ["e"], "it carries only the entry it holds");
  assert.deepEqual(window.superseded[runId(full)], { pass: 2, fail: 1, notRun: 1 }, "the rest are counted by verdict");
  assert.equal(window.omitted, 1, "a run holding nothing and outside the latest is left out and counted");
  const latest = (rs: readonly RunRecord[]) => Object.fromEntries(rs.flatMap((r) => r.invariants.map((e) => [e.name, `${e.verdict} ${r.session}`])));
  assert.deepEqual(latest(window.records), latest(records), "every latest verdict is the one every record gives");
  const state = { ...fixtureState, runs: { ...fixtureState.runs, records: window.records, superseded: window.superseded } };
  const view = renderView(state, "runs").text;
  const article = view.slice(view.indexOf(`id="${runId(full)}"`), view.indexOf("</article>", view.indexOf(`id="${runId(full)}"`)));
  assert.match(article, /3 pass<\/span> <span class="count failing" data-count="fail">1 fail<\/span> <span class="count" data-count="not-run">1 not run<\/span> <span class="quiet">of 5 enforcements/, "the run's totals are its whole run's");
  assert.match(article, /data-field="superseded">4 verdicts later runs superseded are counted here and not listed/, "and the view says why four are not listed");
});
