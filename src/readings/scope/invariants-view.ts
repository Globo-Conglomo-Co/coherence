/**
 * The Invariants view: every bullet with its lifecycle state, enforcement
 * form, chokepoint grade with the rung's enforcer, crossing, because,
 * refutation, checklist, and what it lacks. A structural defect shows its
 * bypass sites and the two honest options. Filtered by state and component,
 * searched by text. A pure function from the shell state to markup.
 */

import { allInvariants, componentId, defectsOf, invariantId, isKept, latestOf, latestRun, plural, relianceId, stamp, textMatches } from "./derive.ts";
import { html, type Markup } from "./html.ts";
import type { LatestEntry, LifecycleState, RunRecord, ShellState, SpecEnforcement, SpecInvariant, TrustLevel } from "./model.ts";

const STATES: readonly LifecycleState[] = ["requirement", "invariant", "structural defect"];

function invariantMatches(invariant: SpecInvariant, query: string, runs: readonly RunRecord[]): boolean {
  return textMatches(
    query,
    invariant.name,
    invariant.sentence,
    invariant.because,
    invariant.component,
    invariant.state,
    invariant.enforcements.map((e) => (e.form === "chokepoint" ? `${e.chokepoint} ${e.protects}` : `${e.via} ${e.over}`)),
    invariant.crossing === undefined ? undefined : `${invariant.crossing.from} ${invariant.crossing.to}`,
    latestOf(invariant, runs).flatMap((l) => l.bypasses.map((b) => `${b.file} ${b.symbol}`)),
  );
}

function levelMeaning(levels: readonly TrustLevel[], name: string): string | undefined {
  return levels.find((l) => l.name === name)?.meaning;
}

function renderCrossing(state: ShellState, invariant: SpecInvariant): Markup {
  const crossing = invariant.crossing;
  if (crossing === undefined) return html`<p class="crossing quiet">no crossing</p>`;
  const from = levelMeaning(state.spec.trustLevels, crossing.from);
  const to = levelMeaning(state.spec.trustLevels, crossing.to);
  return html`<p class="crossing" data-field="crossing"><span class="label">crossing</span>
    <span class="level" title="${from ?? "not a declared trust level"}">${crossing.from}</span> → <span class="level" title="${to ?? "not a declared trust level"}">${crossing.to}</span></p>`;
}

/** The verdict of one enforcement as the latest run left it, or its absence. */
function renderVerdict(state: ShellState, entry: LatestEntry | undefined): Markup {
  if (entry === undefined) return html`<p class="verdict" data-verdict="unverified"><span class="verdict-word">declared, unverified</span> <span class="quiet">no run has checked this enforcement</span></p>`;
  const kept = isKept(entry, state.runs.records);
  const keptMark = kept ? html` <span class="kept" data-kept title="the latest run skipped this enforcement; the verdict stands from the run that last checked it">kept from an earlier run (${stamp(entry.at)})</span>` : null;
  const rung = entry.grade === undefined ? undefined : state.spec.ladder.rungs.find((r) => r.grade === entry.grade);
  const grade =
    entry.grade === undefined
      ? null
      : html`<span class="grade" data-grade="${entry.grade}">${entry.grade}</span>${entry.enforcer !== undefined ? html` <span class="enforced-by quiet">enforced by ${entry.enforcer}</span>` : rung !== undefined ? html` <span class="enforced-by quiet">enforced by ${rung.enforcedBy}</span>` : null}`;
  const word = entry.verdict === "pass" ? `verified ${entry.at.slice(0, 10)}` : entry.verdict === "fail" ? `structural defect ${entry.at.slice(0, 10)}` : `not run ${entry.at.slice(0, 10)}`;
  return html`<p class="verdict" data-verdict="${entry.verdict}"><span class="verdict-word">${word}</span> ${grade}${keptMark}</p>
    <p class="reason quiet">${entry.reason}</p>`;
}

/**
 * Which references the chokepoint governs, as the latest run applied it, with
 * the exempt references counted, so the component's own references read as
 * exempted rather than absent. Nothing is drawn for anywhere, the default.
 */
function renderGoverned(enforcement: Extract<SpecEnforcement, { form: "chokepoint" }>, entry: LatestEntry | undefined): Markup | null {
  const ran = entry?.from;
  if (ran?.exempt !== undefined) {
    // Exempt references the page carries, and those its window counted instead.
    const exempt = entry!.sites === undefined
      ? undefined
      : entry!.sites.filter((s) => s.of === "protected" && s.class === "exempt").length +
        (entry!.sitesLeft ?? []).filter((s) => s.of === "protected" && s.class === "exempt").reduce((sum, s) => sum + s.count, 0);
    const by = ran.by === "bullet" ? "its from: line" : ran.by === "config" ? "the config default" : "the default";
    return html`<p class="governs" data-field="from" data-exempt="${ran.exempt}"><span class="label">from</span> ${ran.value} <span class="quiet">(${by}): governs only references from outside <code>${ran.exempt}</code>; ${entry!.sitesUnresolved !== undefined ? `exempt references unknown: ${entry!.sitesUnresolved}` : exempt === undefined ? "exempt references unrecorded" : `${plural(exempt, "reference", "references")} from inside it exempt, reported and never a bypass`}</span></p>`;
  }
  const declared = enforcement.from;
  if (declared === undefined || declared === "anywhere") return null;
  return html`<p class="governs" data-field="from"><span class="label">from</span> ${typeof declared === "string" ? declared : `outside ${declared.outside}`} <span class="quiet">declared; no run has applied it yet</span></p>`;
}

export function renderEnforcement(state: ShellState, invariant: SpecInvariant, enforcement: SpecEnforcement): Markup {
  const entry = latestOf(invariant, state.runs.records).find((l) => l.form === enforcement.form);
  if (enforcement.form === "chokepoint") {
    return html`<li class="enforcement" data-form="chokepoint">
      <p><span class="label">chokepoint</span> <code>${enforcement.chokepoint}</code> <span class="label">protects</span> <code>${enforcement.protects}</code></p>
      ${renderVerdict(state, entry)}
      ${renderGoverned(enforcement, entry)}
      ${entry !== undefined && entry.testReferences > 0 ? html`<p class="quiet">${plural(entry.testReferences, "test reference", "test references")}, reported and never a bypass.</p>` : null}
    </li>`;
  }
  return html`<li class="enforcement" data-form="totality-oracle">
    <p><span class="label">totality oracle</span> <code>${enforcement.via}</code> <span class="label">over</span> ${enforcement.over}</p>
    ${renderVerdict(state, entry)}
  </li>`;
}

export function renderRefutation(invariant: SpecInvariant, runs: readonly RunRecord[]): Markup {
  const automatic = latestOf(invariant, runs).find((l) => l.form === "chokepoint" && l.refutation === "automatic");
  const refused = latestOf(invariant, runs).find((l) => l.form === "chokepoint" && l.refutation === "refused by the language");
  const checked = latestOf(invariant, runs).find((l) => l.form === "chokepoint" && l.refutation === "refused by the checker");
  const parts: Markup[] = [];
  for (const refutation of invariant.refutations) {
    parts.push(html`<li class="refutation" data-refutation="witnessed"><span class="refutation-word">witnessed ${refutation.date}</span> <span class="broke">${refutation.broke}</span> <span class="arrow">→</span> <span class="saw">${refutation.saw}</span></li>`);
  }
  if (automatic !== undefined) {
    parts.push(html`<li class="refutation" data-refutation="automatic"><span class="refutation-word">automatic from the run ${automatic.at.slice(0, 10)}</span> <span class="quiet">the instrument reported a synthetic reference from outside the chokepoint, so it would report a real one</span></li>`);
  }
  if (refused !== undefined) {
    parts.push(html`<li class="refutation" data-refutation="refused"><span class="refutation-word">refused by the language, run ${refused.at.slice(0, 10)}</span> <span class="quiet">the compiler or interpreter refused a synthetic reference from outside the chokepoint; the refusal is the proof</span> </li>`);
  }
  if (checked !== undefined) {
    parts.push(html`<li class="refutation" data-refutation="refused"><span class="refutation-word">refused by the checker, run ${checked.at.slice(0, 10)}</span> <span class="quiet">${checked.enforcer ?? "the checker"} refused a synthetic import from another module, staged in a throwaway copy; the refusal is the proof</span> </li>`);
  }
  if (parts.length === 0) {
    parts.push(html`<li class="refutation" data-refutation="missing"><span class="refutation-word">missing</span> <span class="quiet">no witnessed firing is written on the bullet and no run has refuted it automatically</span></li>`);
  }
  return html`<section class="refutations" data-field="refutation"><h4>Refutation</h4><ul>${parts}</ul></section>`;
}

function renderChecklist(invariant: SpecInvariant): Markup {
  const kinds = invariant.kinds;
  if (kinds === undefined) return html`<section class="checklist" data-field="checklist"><h4>Checklist</h4><p class="quiet">No kinds line: the decomposition checklist was never run for this bullet.</p></section>`;
  const kindsText = kinds === "none" ? "none" : kinds.join(", ");
  return html`<section class="checklist" data-field="checklist">
    <h4>Checklist <span class="quiet">kinds ${kindsText}: ${plural(invariant.applicable.length, "shape applies", "shapes apply")}</span></h4>
    ${invariant.checklist.length === 0 && invariant.missingShapes.length === 0
      ? html`<p class="quiet">No shape applies.</p>`
      : html`<ul>${invariant.checklist.map((line) =>
          line.outcome === "declared"
            ? html`<li data-outcome="declared"><span class="shape">${line.shape}</span> <span class="label">declared as</span> ${line.as}</li>`
            : html`<li data-outcome="dismissed"><span class="shape">${line.shape}</span> <span class="label">dismissed:</span> ${line.reason}</li>`,
        )}${invariant.missingShapes.map((shape) => html`<li data-outcome="missing"><span class="shape">${shape}</span> <span class="label">neither declared nor dismissed</span></li>`)}</ul>`}
  </section>`;
}

function renderLacks(invariant: SpecInvariant): Markup | null {
  if (invariant.lacks.length === 0 && invariant.unfilled.length === 0) return null;
  return html`<p class="lacks" data-field="lacks">
    ${invariant.lacks.length > 0 ? html`<span class="label">lacks</span> ${invariant.lacks.join(", ")}` : null}
    ${invariant.unfilled.length > 0 ? html`<span class="label">unfilled</span> ${invariant.unfilled.join(", ")}` : null}
  </p>`;
}

/** A structural defect's evidence and the two honest options. */
function renderDefect(invariant: SpecInvariant, runs: readonly RunRecord[]): Markup | null {
  if (invariant.state !== "structural defect") return null;
  const chokepoints = invariant.enforcements.flatMap((e) => (e.form === "chokepoint" ? [e.chokepoint] : []));
  const failing = defectsOf(invariant, runs);
  const sites = failing.flatMap((d) => d.bypasses);
  return html`<section class="defect" data-field="defect">
    <h4>Structural defect</h4>
    ${failing.map((d) => html`<p class="reason">${d.form === "chokepoint" ? "chokepoint" : "totality oracle"} failed ${stamp(d.at)}: ${d.reason}</p>`)}
    ${sites.length > 0
      ? html`<h5>Bypass sites</h5><ul class="bypasses" data-field="bypasses">${sites.map((b) => html`<li><code>${b.file}:${b.line}</code> <span class="label">in</span> <code>${b.symbol}</code>${b.checker === undefined ? null : html` <span class="quiet">${b.checker}</span>`}</li>`)}</ul>`
      : null}
    <h5>The two options</h5>
    <ol class="options" data-field="options">
      <li data-option="route">${chokepoints.length > 0
        ? html`<strong>Route through the chokepoint.</strong> Move each reference above inside ${chokepoints.map((c, i) => html`<code>${c}</code>${i < chokepoints.length - 1 ? ", " : ""}`)} so the protected thing is reached through it and nowhere else; the next run turns the verdict green.`
        : html`<strong>Restore the enforcement.</strong> Make the test the bullet names run and pass under its name again; the next run turns the verdict green.`}</li>
      <li data-option="retire"><strong>Escalate a retirement.</strong> Record the decision with preservation as the rejected alternative, <code>escalate</code> it, and let a human <code>acknowledge</code> with the <a href="#${relianceId(invariant.component, invariant.name)}">reliance listing</a> in view. The invariant stands, and alarms, until then.</li>
    </ol>
  </section>`;
}

function renderInvariant(state: ShellState, invariant: SpecInvariant): Markup {
  const id = invariantId(invariant.component, invariant.name);
  const component = state.spec.components.find((c) => c.folder === invariant.component);
  return html`<article class="entry invariant" id="${id}" data-state="${invariant.state}">
    <div class="margin">
      <h3 class="headword"><a href="#${id}">${invariant.name}</a></h3>
      <p class="status"><span class="state-mark" data-state="${invariant.state}">${invariant.state}</span></p>
      <p class="defined-by"><a class="related-link" href="#${componentId(invariant.component)}">${component?.name ?? invariant.component}</a> <span class="quiet">${component?.specPath ?? invariant.component}:${invariant.line}</span></p>
      ${renderCrossing(state, invariant)}
    </div>
    <div class="body">
      <p class="definition" data-field="sentence">${invariant.sentence}</p>
      ${invariant.because !== undefined
        ? html`<p class="because" data-field="because"><span class="because-word">because</span> ${invariant.because}</p>`
        : html`<p class="because quiet" data-field="because"><span class="because-word">because</span> not written: every invariant carries its own.</p>`}
      <section class="enforcements" data-field="enforcements">
        <h4>Enforcement</h4>
        ${invariant.enforcements.length === 0
          ? html`<p class="quiet">None: the bullet names no chokepoint and no totality oracle, so nothing detects a break.</p>`
          : html`<ul>${invariant.enforcements.map((e) => renderEnforcement(state, invariant, e))}</ul>`}
      </section>
      ${renderDefect(invariant, state.runs.records)}
      ${renderRefutation(invariant, state.runs.records)}
      ${renderChecklist(invariant)}
      ${renderLacks(invariant)}
      ${invariant.enforcements.some((e) => e.form === "chokepoint")
        ? html`<p class="related"><span class="label">Reliance</span> <a class="related-link" href="#${relianceId(invariant.component, invariant.name)}">who references this chokepoint</a></p>`
        : null}
    </div>
  </article>`;
}

export function renderInvariantsTools(state: ShellState): Markup {
  const view = state.invariants;
  return html`<div class="view-tools">
    <label class="search">
      <span class="label">Search</span>
      <input type="search" data-search value="${view.query}" placeholder="name, sentence, because, chokepoint, file, or trust level" autocomplete="off" spellcheck="false">
    </label>
    <div class="filters">
      <label class="filter"><span class="label">State</span>
        <select data-filter="state">
          <option value="" ${view.state === "" ? "selected" : ""}>every state</option>
          ${STATES.map((s) => html`<option value="${s}" ${view.state === s ? "selected" : ""}>${s}</option>`)}
        </select></label>
      <label class="filter"><span class="label">Component</span>
        <select data-filter="component">
          <option value="" ${view.component === "" ? "selected" : ""}>every component</option>
          ${state.spec.components.map((c) => html`<option value="${c.folder}" ${view.component === c.folder ? "selected" : ""}>${c.folder === "." ? c.name : c.folder}</option>`)}
        </select></label>
    </div>
  </div>`;
}

/** The ladder, once, above the cards: each rung and who enforces it. */
function renderLadder(state: ShellState): Markup {
  const ladder = state.spec.ladder;
  return html`<details class="record ladder" data-section="ladder">
    <summary>Chokepoint grade ladder for ${ladder.language}: ${ladder.rungs.map((r) => r.grade).join(", ")}</summary>
    <dl class="record-fields">${ladder.rungs.map((r) => html`<div class="record-field" data-grade="${r.grade}"><dt>${r.grade}</dt><dd>enforced by ${r.enforcedBy}</dd></div>`)}</dl>
  </details>`;
}

export function renderInvariantsResults(state: ShellState): Markup {
  const view = state.invariants;
  const query = view.query.trim().toLowerCase();
  const all = allInvariants(state.spec.components);
  const shown = all.filter(
    (i) => (view.state === "" || i.state === view.state) && (view.component === "" || i.component === view.component) && invariantMatches(i, query, state.runs.records),
  );
  const filtered = view.state !== "" || view.component !== "" || query !== "";
  const counts = state.spec.counts;
  const last = latestRun(state.runs.records);
  return html`<section class="invariants" aria-labelledby="invariants-heading">
    <h2 class="section-heading" id="invariants-heading">Invariants</h2>
    <p class="section-lead">${plural(counts.bullets, "bullet", "bullets")}: ${counts.invariants} ${counts.invariants === 1 ? "invariant" : "invariants"}, ${counts.requirements} ${counts.requirements === 1 ? "requirement" : "requirements"}${counts.structuralDefects > 0 ? html`, <span class="defect-count">${plural(counts.structuralDefects, "structural defect", "structural defects")}</span>` : ""}. ${last === undefined ? "No run yet: every enforcement is declared, unverified." : `Verdicts from the run at ${stamp(last.at)} by ${last.agent}, and from earlier runs where it skipped an enforcement.`}</p>
    ${renderLadder(state)}
    ${!filtered
      ? html`<p class="match-summary quiet">${plural(all.length, "bullet", "bullets")}.</p>`
      : shown.length === 0
        ? html`<p class="match-summary">No bullet matches${query !== "" ? ` “${view.query}”` : ""}${view.state !== "" ? ` in state ${view.state}` : ""}${view.component !== "" ? ` in ${view.component}` : ""}.</p>`
        : html`<p class="match-summary">${shown.length} of ${plural(all.length, "bullet", "bullets")} shown.</p>`}
    ${shown.map((i) => renderInvariant(state, i))}
  </section>`;
}
