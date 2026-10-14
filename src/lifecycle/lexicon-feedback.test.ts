import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Io } from "../journal/cli.ts";
import { cli } from "./cli-fixture.ts";
import { lexiconWorkCommand } from "./lexicon-cli.ts";
import { coverageText, lexiconCoverage } from "./lexicon-coverage.ts";


function emptyRoot(): string {
  return mkdtempSync(join(tmpdir(), "coherence-lexicon-help-"));
}

function io(root: string): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { cwd: root, out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

function writeLexicon(root: string, unitBasis: string, duplicate = false): void {
  const concepts = [
    {
      name: "exposure",
      definition: "The amount subject to loss.",
      aliases: [],
      properties: { unit_basis: unitBasis },
    },
    {
      name: "category",
      definition: "A settled classification.",
      aliases: [],
      properties: {},
    },
    { name: "mass", definition: "Total measured size.", aliases: [], properties: {} },
    { name: "status", definition: "A lifecycle condition.", aliases: [], properties: {} },
    ...(duplicate
      ? [{ name: "allocation", definition: "A distributed share.", aliases: [], properties: { unit_basis: "percentage" } }]
      : []),
  ];
  writeFileSync(join(root, "lexicon.json"), JSON.stringify({ version: 1, project: "risk", concepts }));
}

function coverageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "coherence-lexicon-feedback-"));
  mkdirSync(join(root, "risk"));
  writeFileSync(join(root, "risk/Risk.spec.md"), "# Risk\n\n## invariants\n");
  writeFileSync(
    join(root, "risk/notes.md"),
    "The `exposures` use a `unit_basis`. `categories`, `mass`, and `status` are declared; `exposureBucket` is not.\n",
  );
  writeLexicon(root, "USD");
  return root;
}

test("root and workflow help are data-free, useful, and do not turn unknown flags into help", async () => {
  const root = emptyRoot();
  try {
    const rootHelp = io(root);
    assert.equal(await lexiconWorkCommand(["help"], rootHelp.io), 0);
    assert.ok(rootHelp.out.join("\n").startsWith("usage:\n"));
    assert.match(rootHelp.out.join("\n"), /lexicon coverage \[--json\]/);
    assert.equal(rootHelp.err.length, 0);
    const rootProcess = await cli(["lexicon", "--help"], { cwd: root });
    assert.equal(rootProcess.status, 0, rootProcess.stderr);
    assert.ok(rootProcess.stdout.startsWith("usage:\n"));
    assert.match(rootProcess.stdout, /lexicon changes \[--session/);
    assert.doesNotMatch(rootProcess.stderr, /ENOENT|lexicon\.json/);

    for (const verb of ["coverage", "review", "propose", "apply", "recover", "draft", "baseline", "changes", "ready", "similar", "model"]) {
      const sink = io(root);
      assert.equal(await lexiconWorkCommand([verb, "--help"], sink.io), 0, `${verb}: ${sink.err.join("\n")}`);
      assert.match(sink.out.join("\n"), new RegExp(`lexicon ${verb}`));
      assert.equal(sink.err.length, 0);
    }

    const workflowUnknown = io(root);
    assert.equal(await lexiconWorkCommand(["changes", "--bogus"], workflowUnknown.io), 1);
    assert.match(workflowUnknown.err.join("\n"), /unknown flag --bogus/);
    const rootUnknown = await cli(["lexicon", "--bogus"], { cwd: root });
    assert.equal(rootUnknown.status, 1);
    assert.match(rootUnknown.stderr, /unknown flag --bogus/);
    assert.equal(rootUnknown.stdout, "");
    assert.deepEqual(readdirSync(root), [], "help and flag validation do not create project state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage maps only conservative inflections to known meanings and preserves the observed spelling", async () => {
  const root = coverageRoot();
  try {
    const report = await lexiconCoverage(root);
    const exposures = report.terms.find((term) => term.term === "exposures");
    assert.equal(exposures?.state, "declared", "the observed plural is recognized without recasting it as the canonical spelling");
    assert.equal(exposures?.concept, "exposure");
    assert.equal(exposures?.definition, "The amount subject to loss.");

    const categories = report.terms.find((term) => term.term === "categories");
    assert.equal(categories?.concept, "category", "-ies is recognized only because category is declared");
    assert.equal(report.terms.find((term) => term.term === "mass")?.concept, "mass");
    assert.equal(report.terms.find((term) => term.term === "status")?.concept, "status");
    const bucket = report.terms.find((term) => term.term === "exposure bucket");
    assert.ok(bucket === undefined || (bucket.state === "unresolved" && bucket.concept === null), "a compound is not inferred from one known word");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a property spelling carries its owner and property value into meaning evidence, while shared spellings expose every alternative", async () => {
  const root = coverageRoot();
  try {
    const usd = await lexiconCoverage(root);
    const first = usd.terms.find((term) => term.term === "unit basis")!;
    assert.equal(first.state, "declared");
    assert.equal(first.concept, "exposure");
    assert.equal(first.definition, "The amount subject to loss.");
    assert.deepEqual(first.properties, { unit_basis: "USD" });
    assert.equal(first.meaningAlternatives, undefined);

    writeLexicon(root, "percentage");
    const percentage = await lexiconCoverage(root);
    const changed = percentage.terms.find((term) => term.term === "unit basis")!;
    assert.deepEqual(changed.properties, { unit_basis: "percentage" });
    assert.notEqual(changed.fingerprint, first.fingerprint, "the named property's meaning fingerprint changes");
    assert.notEqual(changed.contexts[0]?.fingerprint, first.contexts[0]?.fingerprint, "property edits reopen context review evidence");

    writeLexicon(root, "percentage", true);
    const shared = await lexiconCoverage(root);
    const ambiguous = shared.terms.find((term) => term.term === "unit basis")!;
    assert.equal(ambiguous.concept, null, "no last owner is silently selected");
    assert.equal(ambiguous.definition, null);
    assert.deepEqual(ambiguous.properties, {});
    assert.deepEqual(ambiguous.meaningAlternatives?.map((meaning) => meaning.concept), ["exposure", "allocation"]);
    assert.deepEqual(ambiguous.meaningAlternatives?.map((meaning) => meaning.properties.unit_basis), ["percentage", "percentage"]);
    const text = coverageText(shared, "unit basis");
    assert.match(text, /applicable property meaning: exposure/);
    assert.match(text, /applicable property meaning: allocation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
