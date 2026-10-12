/**
 * The Practices view: the story of what a project practices told before any
 * practice's health, each step's adherence strip, and the journal window
 * keeping what the practices need.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { KINDS, WORK_KINDS, recordId, type Kind, type WorkKind } from "../../journal/record.ts";
import { ENACTMENT_WINDOW, windowJournal } from "./derive.ts";
import type { JournalRecord, ScopePractice, ShellState } from "./model.ts";
import { STRIP_WINDOW, adherence, citationKind, practiceOrigin, practiceStoryText } from "./practices.ts";
import { renderPracticesResults } from "./practices-view.ts";

const head = (id: string, at: string) => ({ id, at, session: "s1", agent: "main", commit: null, dirty: false });

function practice(over: Partial<ScopePractice> = {}): ScopePractice {
  return {
    id: "src/widget/oil the knob",
    name: "oil the knob",
    sentence: "A knob is oiled before it turns.",
    component: "src/widget",
    file: "src/widget/Widget.practice.md",
    kernel: false,
    triggers: [{ kind: "command", words: "turn-knob" }, { kind: "edit", glob: "src/widget/**/*.ts", adding: "knob" }],
    steps: [{ n: 1, text: "wipe the knob" }, { n: 2, text: "oil the knob", leaves: "an oil record" }, { n: 3, text: "turn it once" }],
    pitfalls: [{ text: "a dry knob seized (df-0000aaaa)", cites: ["df-0000aaaa"] }],
    learned: ["d-0000bbbb"],
    invariants: [],
    version: "11111111",
    state: "candidate",
    enactments: 0,
    ...over,
  };
}

function enactment(id: string, at: string, results: Record<string, unknown>, steps = practice().steps.map((s) => (s.leaves ? { text: s.text, leaves: s.leaves } : { text: s.text }))): JournalRecord {
  return { ...head(id, at), kind: "enactment", practice: "src/widget/oil the knob", version: "11111111", trigger: "command turn-knob", steps, pitfalls: [], results } as JournalRecord;
}

function state(practices: ScopePractice[], records: JournalRecord[]): ShellState {
  return {
    practices: { practices },
    practicesView: { query: "" },
    journal: { records, damaged: [], work: { kind: "absent", because: "" } },
    spec: {
      entry: ".",
      trustLevels: [],
      components: [
        { folder: "src/widget", name: "Widget", specPath: "src/widget/Widget.spec.md", intent: "", trustLevels: undefined, entrances: [], invariants: [], parent: undefined, children: [] },
        { folder: "src/gadget", name: "Gadget", specPath: "src/gadget/Gadget.spec.md", intent: "", trustLevels: undefined, entrances: [], invariants: [], parent: undefined, children: [] },
      ],
      problems: [],
      counts: { components: 2, bullets: 0, invariants: 0, requirements: 0, structuralDefects: 0, lacking: { enforcement: 0, refutation: 0, kinds: 0, checklist: 0, because: 0 }, unfilled: 0, problems: 0 },
      ladder: { language: "typescript", rungs: [] },
    },
  } as unknown as ShellState;
}

test("the Practices view opens with what the project practices: every trigger of every practice in the when-you list, the components with and without practices, the kernel, and what has no practice yet, before any practice's card", () => {
  const kernel = practice({ id: "coherence:src/enforcement/witness a refutation", name: "witness a refutation", component: "src/enforcement", file: "src/enforcement/Enforcement.practice.md", kernel: true, triggers: [{ kind: "command", words: "refute" }] });
  const defect = { ...head("df-0000cccc", "2026-10-01T00:00:00.000Z"), kind: "defect", what: "the gadget jammed", evidence: "seen", files: ["src/gadget/jam.ts"] } as JournalRecord;
  const s = state([practice(), kernel], [defect]);
  const page = renderPracticesResults(s).text;
  const story = page.indexOf('data-field="practice-story"');
  const card = page.indexOf('class="entry practice"');
  assert.ok(story >= 0 && card > story, "the story comes before any practice's card");
  for (const when of ["When you run <code>turn-knob</code>", "When you edit <code>src/widget/**/*.ts</code> adding <code>knob</code>", "When you run <code>refute</code>"]) assert.ok(page.includes(when), when);
  assert.match(page, /data-field="practice-summary">This project keeps 2 practices: 1 of its own, in <code>src\/widget<\/code>, and 1 kernel practice from Coherence\./);
  assert.match(page, /data-field="kernel-practices">From Coherence, the kernel: /);
  assert.match(page, /data-field="bare-components">No practice of their own: .*Gadget/);
  assert.match(page, /data-field="unpracticed">[\s\S]*Gadget<\/a>: 1 defect or wall on record and no practice of its own/);
  const text = practiceStoryText(s);
  assert.match(text, /When you run turn-knob → src\/widget\/oil the knob/, "the agent query tells the same story");
  assert.match(text, /from Coherence, the kernel: witness a refutation/);
});

test("each step's strip classifies every enactment it shows: evidenced, claimed, done, deviated, skipped, and absent when the version enacted lacked the step, and repeated deviation suggests an amendment", () => {
  const older = [{ text: "oil the knob", leaves: "an oil record" }, { text: "turn it once" }];
  const records = [
    enactment("en-00000001", "2026-10-01T00:00:00.000Z", { "1": { result: "done", evidence: "oil 1" }, "2": { result: "done" } }, older),
    enactment("en-00000002", "2026-10-02T00:00:00.000Z", { "1": { result: "done" }, "2": { result: "done" }, "3": { result: "deviated", because: "turned by hand" } }),
    enactment("en-00000003", "2026-10-03T00:00:00.000Z", { "1": { result: "skipped", because: "already clean" }, "2": { result: "done", evidence: "oil 3" }, "3": { result: "deviated", because: "turned by hand" } }),
  ];
  const [wipe, oil, turn] = adherence(practice(), records);
  assert.deepEqual(wipe!.cells.map((c) => c.cell), ["absent", "done", "skipped"], "the first enactment's version had no wipe step");
  assert.deepEqual(oil!.cells.map((c) => c.cell), ["evidenced", "claimed", "evidenced"], "a step that names its evidence and was done without it is claimed");
  assert.deepEqual(turn!.cells.map((c) => c.cell), ["done", "deviated", "deviated"]);
  assert.deepEqual(turn!.reasons, [{ text: "turned by hand", result: "deviated", count: 2 }]);
  assert.equal(turn!.amendmentSuggested, true);
  assert.equal(wipe!.amendmentSuggested, false, "a skip is not a deviation");
});

test("the journal window keeps each practice's latest enactments, every amendment and what it cites, and every record the practices cite, whatever its age, and the Practices view says how many enactments it holds", () => {
  const day = (i: number) => new Date(Date.UTC(2026, 8, 2) + i * 3_600_000).toISOString();
  const enacted = Array.from({ length: 20 }, (_, i) => enactment(`en-${String(i).padStart(8, "0")}`, day(i), { "1": { result: i % 3 === 0 ? "skipped" : "done", because: "clean" }, "2": { result: "done", evidence: `oil ${i}` }, "3": { result: i % 4 === 0 ? "deviated" : "done", because: "by hand" } }));
  const old: JournalRecord[] = [
    { ...head("df-0000aaaa", "2026-09-01T00:00:00.000Z"), kind: "defect", what: "an old lesson", evidence: "", files: [] } as JournalRecord,
    ...enacted,
    { ...head("d-0000dddd", "2026-09-03T00:00:00.000Z"), kind: "decision", chose: "amend the practice", over: [], because: "", cites: ["en-00000002"] } as JournalRecord,
    { ...head("d-0000eeee", "2026-09-04T00:00:00.000Z"), kind: "decision", chose: "an unrelated old decision", over: [], because: "" } as JournalRecord,
  ];
  const recent = Array.from({ length: 30 }, (_, i) => ({ ...head(`d-1${String(i).padStart(7, "0")}`, `2026-10-0${1 + (i % 9)}T00:00:00.000Z`), kind: "decision", chose: `recent ${i}`, over: [], because: "" }) as JournalRecord);
  const all = [...old, ...recent];
  const window = windowJournal(all, 10, [], undefined, new Set(["df-0000aaaa"]));
  const ids = new Set(window.records.map((r) => r.id));
  const latest = enacted.slice(-ENACTMENT_WINDOW).map((e) => e.id);
  assert.equal(ENACTMENT_WINDOW, STRIP_WINDOW, "the window keeps what the strips read");
  for (const id of latest) assert.ok(ids.has(id), `${id}: one of the practice's latest enactments`);
  assert.ok(ids.has("en-00000002"), "an enactment an amendment cites, however old");
  assert.ok(ids.has("d-0000dddd"), "the decision that cites an enactment: an amendment");
  assert.ok(ids.has("df-0000aaaa"), "a record a practice cites");
  assert.ok(!ids.has("d-0000eeee"), "an old record nothing needs stays out");
  const out = enacted.filter((e) => !ids.has(e.id));
  assert.equal(out.length, 20 - ENACTMENT_WINDOW - 1, "an older enactment nothing cites stays out");
  assert.equal(window.records.length + window.omitted, all.length, "and is counted");
  assert.deepEqual(adherence(practice(), window.records), adherence(practice(), all), "every strip is the one every enactment gives");

  const held = enacted.filter((e) => ids.has(e.id)).length;
  const snapshot = renderPracticesResults({ ...state([practice({ enactments: 20 })], window.records), connection: { mode: "snapshot", status: "live" } } as ShellState).text;
  assert.ok(snapshot.includes(`Enacted 20 times; the latest ${held} on this page</summary>`), "the list says how many of every enactment it holds");
  assert.ok(snapshot.includes(`${20 - held} earlier enactments are not embedded in this page; <code>journal --kind enactment</code> lists every one.`), "a snapshot says where the rest are");
  const live = renderPracticesResults({ ...state([practice({ enactments: 20 })], window.records), connection: { mode: "live", status: "live", version: "v" } } as ShellState).text;
  assert.match(live, /data-field="enactments-left">7 earlier enactments are not loaded yet\. <button type="button" class="history-load" data-history="journal">/, "a live page offers the rest");
  const whole = renderPracticesResults(state([practice({ enactments: 20 })], all)).text;
  assert.ok(whole.includes("Enacted 20 times</summary>") && !whole.includes('data-field="enactments-left"'), "with every enactment held, nothing is said left out");
});

test("a citation's kind is read off the minter's tables: an id of every journal and work kind names its kind, and a practice's evidence counts each", () => {
  const minted = [
    ...(Object.keys(KINDS) as Kind[]).map((kind) => ({ id: recordId(kind, "s1", "2026-10-11T00:00:00.000Z", kind), named: kind as string })),
    ...(Object.keys(WORK_KINDS) as WorkKind[]).map((kind) => ({ id: recordId(kind, "s1", "2026-10-11T00:00:00.000Z", kind), named: `work ${kind}` })),
  ];
  for (const { id, named } of minted) assert.equal(citationKind(id), named, id);
  assert.equal(citationKind("e76cbca"), "commit");
  const origin = practiceOrigin(practice({ pitfalls: [], learned: minted.map((m) => m.id) }), []);
  assert.doesNotMatch(origin.learnedFrom, /\brecord/, origin.learnedFrom);
  assert.match(origin.learnedFrom, /1 work move/);
});
