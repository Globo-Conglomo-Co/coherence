/**
 * The live reading: the warm server answers the fixture project over HTTP,
 * and a client reads it the way the page does (first load, event stream,
 * history by cursor), folding every update with the page's own merge.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { loadRuns } from "../../enforcement/record.ts";
import { connectAdapter, serve, type Serving } from "../../enforcement/server.ts";
import { loadJournal } from "../../journal/store.ts";
import { COHERENCE_LEXICON } from "../../lifecycle/project.ts";
import { closeWork, openWork } from "../../lifecycle/work-meter.ts";
import { CONFIG_FILE, loadSpecModel } from "../../spec/model.ts";
import { scopeState } from "./build.ts";
import { makeFixture, type Fixture } from "./check-fixture.ts";
import { latestOf } from "./derive.ts";
import { scopeApp, storeOf, watchedLexicons } from "./live.ts";
import type { JournalRecord, PageEntry, RecordedSite, RunRecord, ShellState } from "./model.ts";
import { renderShell, renderView } from "./shell.ts";
import { applyUpdate, cursorsOf, mergeJournal, mergeRuns, mergeSites, parseStream, runKeyOf, type StreamEvent } from "./updates.ts";

interface Live {
  serving: Serving;
  base: string;
  token: string;
  get: (path: string) => Promise<unknown>;
  stop: () => Promise<void>;
}

/** Serve a root with the live reading (no instrument reading, a short settle) and ask it for HTTP, as `scope` does. */
async function live(root: string): Promise<Live> {
  const serving = await serve(root, { idleMs: 60_000, http: scopeApp({ interfaces: false, debounceMs: 30 }) });
  const connected = await connectAdapter(root, { spawn: false });
  const { url } = await connected.adapter.openHttp();
  await connected.adapter.close();
  const address = new URL(url);
  const token = address.searchParams.get("token")!;
  const base = `${address.protocol}//${address.host}`;
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, `${path}: ${response.status}`);
    return response.json();
  };
  return { serving, base, token, get, stop: () => serving.stop() };
}

/** An open event stream, read as the page reads it; `until` waits for a condition over the events so far. */
interface Stream {
  events: StreamEvent[];
  until: (done: (events: StreamEvent[]) => boolean, ms?: number) => Promise<boolean>;
  close: () => void;
}

async function openStream(server: Live, state: ShellState): Promise<Stream> {
  const cursors = cursorsOf(state);
  const query = new URLSearchParams({ journal: cursors.journal, runs: cursors.runs, work: cursors.work, version: state.connection?.version ?? "" });
  const abort = new AbortController();
  const response = await fetch(`${server.base}/api/events?${query.toString()}`, { headers: { authorization: `Bearer ${server.token}` }, signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events: StreamEvent[] = [];
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const parsed = parseStream(buffer + value);
        buffer = parsed.rest;
        events.push(...parsed.events);
      }
    } catch {
      // Aborted.
    }
  })();
  const until = async (done: (events: StreamEvent[]) => boolean, ms = 8_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (done(events)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return done(events);
  };
  return { events, until, close: () => abort.abort() };
}

/** Fold every event after the first `from` into the state, as the page does; returns how many were applied. */
function fold(state: ShellState, events: readonly StreamEvent[], from = 0): number {
  for (const event of events.slice(from)) {
    const data: unknown = JSON.parse(event.data);
    if (event.event === "ready") state.connection = { ...state.connection, mode: "live", status: "live", version: (data as { version: string }).version };
    else applyUpdate(state, event.event, data);
  }
  return events.length;
}

async function firstLoad(server: Live): Promise<ShellState> {
  const first = (await server.get("/api/state")) as { state: ShellState; version: string; history: { journal?: string; runs?: string } };
  first.state.connection = { mode: "live", status: "connecting", version: first.version, history: first.history };
  return first.state;
}

function decision(fixture: Fixture, id: string, at: string, chose: string): JournalRecord {
  return { id, kind: "decision", at, session: fixture.names.session, agent: "live-test", commit: "abc1234", dirty: false, chose, over: ["a reload"], because: "the page follows the journal" };
}

function appendJournal(fixture: Fixture, record: JournalRecord): void {
  appendFileSync(join(fixture.root, ".coherence", "journal", `${fixture.names.session}.jsonl`), JSON.stringify(record) + "\n");
}

function appendRun(fixture: Fixture, at: string): void {
  const run = { at, session: fixture.names.session, agent: "live-test", commit: "abc1234", dirty: false, instrument: { language: "typescript", server: "warm" }, latency: 1, invariants: [{ component: "src/store", name: "read shape", form: "totality oracle", verdict: "pass", mode: "batched", refutation: "witnessed", bypasses: [], testReferences: 0, files: [], latency: 1, reason: "1 test passed" }] };
  appendFileSync(join(fixture.root, ".coherence", "runs", `${fixture.names.session}.jsonl`), JSON.stringify(run) + "\n");
}

const ids = (state: ShellState): string[] => state.journal.records.map((record) => record.id);

test("a journal record appended while a page is connected reaches it as a live update, and a run the same way", async () => {
  const fixture = makeFixture();
  const server = await live(fixture.root);
  try {
    const state = await firstLoad(server);
    const stream = await openStream(server, state);
    assert.ok(await stream.until((events) => events.some((e) => e.event === "ready")), "the stream says it is ready");
    let seen = fold(state, stream.events);
    const record = decision(fixture, "d-11ve0001", new Date().toISOString(), "the page shows a record the moment it is appended");
    appendJournal(fixture, record);
    assert.ok(await stream.until((events) => events.some((e) => e.event === "journal" && e.data.includes(record.id))), "the append arrives on the stream without a reload");
    seen = fold(state, stream.events, seen);
    assert.ok(ids(state).includes(record.id), "the merged state holds it");
    assert.match(renderView(state, "journal").text, new RegExp(`id="journal-${record.id}"`), "and the journal view renders its card");
    const run = new Date(Date.now() + 1000).toISOString();
    appendRun(fixture, run);
    assert.ok(await stream.until((events) => events.some((e) => e.event === "runs" && e.data.includes(run))), "a run arrives the same way");
    fold(state, stream.events, seen);
    assert.ok(state.runs.records.some((r) => r.at === run), "the merged state holds the run");
    assert.equal(new Set(ids(state)).size, ids(state).length, "no record is held twice");
    stream.close();
  } finally {
    await server.stop();
    fixture.remove();
  }
});

test("a page that reconnects with its cursors gets every record appended while it was away, each once, across a server restart", async () => {
  const fixture = makeFixture();
  let server = await live(fixture.root);
  try {
    const state = await firstLoad(server);
    const stream = await openStream(server, state);
    assert.ok(await stream.until((events) => events.some((e) => e.event === "ready")));
    fold(state, stream.events);
    const before = ids(state);
    const latest = state.journal.records.at(-1)!;
    stream.close();

    // Away from the same server: one record after the page's cursor, and one a slower writer stamped a moment before the page's latest.
    const early = decision(fixture, "d-a11b0001", new Date(Date.parse(latest.at) + 4_000).toISOString(), "appended while the page was away from a running server");
    const slow = decision(fixture, "d-a11b0000", new Date(Date.parse(latest.at) - 2_000).toISOString(), "stamped before the page's latest, appended after it, same server");
    for (const record of [early, slow]) appendJournal(fixture, record);
    // The server has read both before the page returns, so only the catch-up can bring them: nothing is broadcast to a page that is away.
    const has = async (id: string): Promise<boolean> => (await fetch(`${server.base}/api/record?id=${id}`, { headers: { authorization: `Bearer ${server.token}` } })).status === 200;
    for (let i = 0; i < 200 && !((await has(early.id)) && (await has(slow.id))); i++) await new Promise((r) => setTimeout(r, 25));
    const back = await openStream(server, state);
    assert.ok(await back.until((events) => events.some((e) => e.event === "ready")), "the page reconnects to the running server");
    assert.ok(!back.events.some((e) => e.event === "snapshot"), "the same server's version is the page's, so no snapshot is resent");
    fold(state, back.events);
    for (const record of [early, slow]) assert.equal(ids(state).filter((id) => id === record.id).length, 1, `${record.id} is held exactly once after the catch-up`);
    back.close();
    const { port } = new URL(server.base);
    await server.stop();

    // While the page is away and the server is down: a record after its cursor, a second one, and one a slower writer stamped before its latest.
    const later = decision(fixture, "d-a11a0001", new Date(Date.parse(latest.at) + 5_000).toISOString(), "appended while the page was away");
    const second = decision(fixture, "d-a11a0002", new Date(Date.parse(latest.at) + 6_000).toISOString(), "appended while the page was away, second");
    const late = decision(fixture, "d-a11a0000", new Date(Date.parse(latest.at) - 1_000).toISOString(), "stamped before the page's latest, appended after it");
    for (const record of [later, second, late]) appendJournal(fixture, record);

    server = await live(fixture.root);
    assert.equal(new URL(server.base).port, port, "the restarted server answers where the page left it");
    const again = await openStream(server, state);
    assert.ok(await again.until((events) => events.some((e) => e.event === "ready")), "the page reconnects with the same token");
    fold(state, again.events);
    const after = ids(state);
    for (const record of [early, slow, later, second, late]) assert.equal(after.filter((id) => id === record.id).length, 1, `${record.id} is held exactly once`);
    assert.equal(new Set(after).size, after.length, "no record is held twice");
    for (const id of before) assert.ok(after.includes(id), `${id}, held before, is still held`);
    assert.equal(after.length, before.length + 5, "nothing was lost and nothing added twice");
    const caughtUp = again.events.filter((e) => e.event === "journal").flatMap((e) => (JSON.parse(e.data) as { records: JournalRecord[] }).records.map((r) => r.id));
    assert.ok(caughtUp.includes(latest.id), "the catch-up overlapped what the page held, and the merge kept one copy");
    again.close();
  } finally {
    await server.stop();
    fixture.remove();
  }
});

test("the first load stays flat as the journal and the runs grow, every derived verdict is unchanged, and history loads every record left out by cursor, once", async () => {
  const grown = makeFixture();
  try {
    const session = "s-growth";
    const grow = (records: number, runs: number, from: number): void => {
      const journal = Array.from({ length: records }, (_, i) => JSON.stringify({ id: `d-${(from + i).toString(16).padStart(8, "0")}`, kind: "decision", at: new Date(Date.UTC(2026, 8, 12) + (from + i) * 1000).toISOString(), session, agent: "growth", commit: "abc1234", dirty: false, chose: `choice ${from + i} with some words to weigh the record`, over: ["the other one"], because: "the test grows the journal" }));
      appendFileSync(join(grown.root, `.coherence/journal/${session}.jsonl`), journal.join("\n") + "\n");
      const run = (i: number): string => JSON.stringify({ at: new Date(Date.UTC(2026, 8, 12) + (from + i) * 1000).toISOString(), session, agent: "growth", commit: "abc1234", dirty: false, instrument: { language: "typescript", server: "warm" }, latency: 3, invariants: [{ component: "src/store", name: "read shape", form: "totality oracle", verdict: "pass", mode: "batched", refutation: "witnessed", bypasses: [], testReferences: 0, files: [], latency: 1, reason: "1 test passed" }] });
      appendFileSync(join(grown.root, `.coherence/runs/${session}.jsonl`), Array.from({ length: runs }, (_, i) => run(i)).join("\n") + "\n");
    };
    // The chokepoint's latest check, with more reference sites each time: the code grows as well as the stores.
    const check = (sites: number, phase: number): RecordedSite[] => {
      const recorded = Array.from({ length: sites }, (_, i): RecordedSite => ({ file: i % 3 === 0 ? "src/api/handler.test.ts" : "src/api/handler.ts", line: i + 1, symbol: `caller${i}`, class: i % 3 === 0 ? "test" : "chokepoint-reference", of: "chokepoint", test: i % 3 === 0 }));
      const entry = { component: "src/store", name: "single writer", form: "chokepoint", grade: "reference-choked", verdict: "pass", refutation: "automatic", bypasses: [], testReferences: 0, files: [], latency: 1, reason: "every write passes the door", sites: recorded };
      appendFileSync(join(grown.root, `.coherence/runs/s-check.jsonl`), JSON.stringify({ at: new Date(Date.UTC(2026, 8, 13) + phase * 1000).toISOString(), session: "s-check", agent: "growth", commit: "abc1234", dirty: false, instrument: { language: "typescript", server: "warm" }, latency: 3, invariants: [entry] }) + "\n");
      return recorded;
    };
    const firstLoadBytes = async (): Promise<{ bytes: number; state: ShellState; server: Live }> => {
      const server = await live(grown.root);
      const response = await fetch(`${server.base}/api/state`, { headers: { authorization: `Bearer ${server.token}` } });
      const text = await response.text();
      const first = JSON.parse(text) as { state: ShellState; version: string; history: { journal?: string; runs?: string } };
      first.state.connection = { mode: "live", status: "live", version: first.version, history: first.history };
      return { bytes: Buffer.byteLength(text, "utf8"), state: first.state, server };
    };
    grow(400, 60, 0);
    check(800, 0);
    const small = await firstLoadBytes();
    await small.server.stop();
    grow(2000, 300, 400);
    const sites = check(8000, 1);
    const large = await firstLoadBytes();
    try {
      assert.ok(Math.abs(large.bytes - small.bytes) < 1024, `the first load stays flat: ${small.bytes} bytes, then ${large.bytes} after 2000 records, 300 runs and 7200 reference sites more`);
      const state = large.state;
      const allJournal = loadJournal(grown.root).records;
      const allRuns = loadRuns(grown.root).records;
      assert.equal(state.journal.records.length + (state.journal.omitted ?? 0), allJournal.length, "every journal record is loaded or counted");
      assert.equal(state.runs.records.length + (state.runs.omitted ?? 0), allRuns.length, "every run is loaded or counted");
      assert.ok(state.journal.records.some((r) => r.id === grown.names.openEscalation), "an open escalation is in the first load however old");
      const whole = await scopeState({ root: grown.root, lexiconPath: COHERENCE_LEXICON, project: "Fixture", window: false });
      // The reference sites the first load counted and did not list load by their run and enforcement, every one.
      const latestCheck = state.runs.records.find((r) => r.session === "s-check" && r.at === new Date(Date.UTC(2026, 8, 13) + 1000).toISOString())!;
      const carried = latestCheck.invariants[0] as PageEntry;
      assert.ok(carried.sites!.length < sites.length && carried.sitesLeft !== undefined, `the first load lists ${carried.sites!.length} of ${sites.length} sites and counts the rest`);
      const answer = (await large.server.get(`/api/sites?run=${encodeURIComponent(runKeyOf(latestCheck))}&component=src%2Fstore&name=single%20writer`)) as { sites: RecordedSite[] };
      assert.deepEqual(answer.sites, sites, "the live page's server answers every site of the entry");
      assert.ok(mergeSites(state, runKeyOf(latestCheck), "src/store", "single writer", answer.sites));
      for (const invariant of whole.spec.components.flatMap((c) => c.invariants)) {
        assert.deepEqual(latestOf(invariant, state.runs.records), latestOf(invariant, whole.runs.records), `${invariant.name}: the first load derives the same latest verdicts`);
      }
      assert.match(renderShell(state).text, new RegExp(`${allJournal.length} journal records`), "the masthead counts every record");
      assert.match(renderView(state, "journal").text, /data-history="journal"/, "the journal view offers the rest");

      // Page back as the page does: from the server's hint, then below the oldest record each page returned.
      for (const store of ["journal", "runs"] as const) {
        let before = state.connection!.history![store] ?? "";
        for (let pages = 0; pages < 50; pages++) {
          const answer = (await large.server.get(`/api/${store}?before=${encodeURIComponent(before)}&limit=200`)) as { records: (JournalRecord | RunRecord)[]; more: boolean };
          if (store === "journal") mergeJournal(state, answer.records as JournalRecord[], true);
          else mergeRuns(state, answer.records as RunRecord[], true);
          const oldest = answer.records[0] as { at: string; id?: string; session: string } | undefined;
          if (!answer.more || oldest === undefined) break;
          before = `${oldest.at}~${oldest.id ?? oldest.session}`;
        }
      }
      assert.deepEqual(ids(state), allJournal.map((r) => r.id), "history loaded every journal record, in order, once");
      assert.equal(state.journal.omitted, undefined, "and nothing is counted as left out");
      assert.deepEqual(state.runs.records.map(runKeyOf), allRuns.map(runKeyOf), "and every run, once");
      assert.equal(state.runs.omitted, undefined);
      const found = (await large.server.get(`/api/journal?q=${encodeURIComponent("choice 17 with")}`)) as { records: JournalRecord[] };
      assert.deepEqual(found.records.map((r) => r.id), [`d-${(17).toString(16).padStart(8, "0")}`], "a search reaches records the first load left out");
      const one = (await large.server.get(`/api/record?id=${encodeURIComponent(allJournal[3]!.id)}`)) as { records: JournalRecord[] };
      assert.equal(one.records[0]?.id, allJournal[3]!.id, "a citation's record loads by id");
    } finally {
      await large.server.stop();
    }
  } finally {
    grown.remove();
  }
});

test("every file the spec model reads by name refreshes the live reading: each spec and practice file it read for a project with components and a practice, and the config", async () => {
  // A project shaped as Coherence's own is (a root spec, components, a practice beside a spec), never Coherence's whole tree, whose listing costs more with every merge.
  const root = mkdtempSync(join(tmpdir(), "coherence-live-model-"));
  const files: Record<string, string> = {
    [CONFIG_FILE]: JSON.stringify({ name: "model" }),
    "Model.spec.md": "# Model\n\nThe project.\n",
    "src/gadget/Gadget.spec.md": "# Gadget\n\nThe gadget.\n",
    "src/gadget/Gadget.practice.md": "- tune the gadget: A gadget is tuned before it ships.\n  when: command gadget tune\n  step: tune it\n  because: an untuned gadget rattles\n",
    "src/gadget/gadget.ts": "export const gadget = 1;\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const scope = openWork();
  try {
    loadSpecModel(root, { runs: false });
  } finally {
    closeWork(scope);
    rmSync(root, { recursive: true, force: true });
  }
  const named = scope.work.reads.filter((read) => read.startsWith("spec ") || read.startsWith("practice ")).map((read) => relative(root, read.slice(read.indexOf(" ") + 1)));
  assert.ok(named.some((file) => file.endsWith(".practice.md")), "the model read a practice file");
  for (const file of named) assert.equal(storeOf(file, []), "model", `${file} is read by the model, so a change to it refreshes the reading`);
  assert.equal(storeOf(CONFIG_FILE, []), "model");
  assert.equal(storeOf("src/widget/Widget.practice.md", []), "model", "a practice file not yet written refreshes the reading once it is");
  assert.equal(storeOf("src/widget/widget.ts", []), undefined, "a source file is no file the model reads by name");
  // The lexicons are located as the state's load locates them: a config that names one elsewhere is followed.
  const project = mkdtempSync(join(tmpdir(), "coherence-live-lexicon-"));
  try {
    writeFileSync(join(project, CONFIG_FILE), JSON.stringify({ lexicon: "vocab/terms.json" }));
    const lexicons = await watchedLexicons(project, { lexiconPath: COHERENCE_LEXICON });
    assert.equal(storeOf("vocab/terms.json", lexicons), "model", "the lexicon the config names refreshes the reading");
    assert.equal(storeOf("lexicon.json", lexicons), "model", "and one written later at the default name");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
