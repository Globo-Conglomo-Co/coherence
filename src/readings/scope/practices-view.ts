/**
 * The Practices view: the story of what a project practices, then how each
 * practice is holding. A pure function from the shell state to markup.
 *
 * The story leads: an opening paragraph, the project's working rules by what
 * sets them off ("when you… → follow…"), where the practices live, and what
 * has no practice yet. Below it, what needs attention, then one card per
 * practice: its triggers, its steps each with an adherence strip over the
 * latest enactments and the reasons given for deviating, its pitfalls with
 * the records that witnessed them, where it came from, and its enactments.
 */

import { componentId, invariantId, plural, shortSession, stamp } from "./derive.ts";
import { html, slug, type Markup } from "./html.ts";
import type { JournalRecord, ScopePractice, ShellState } from "./model.ts";
import { adherence, attention, citationKind, enactmentsOf, practiceId, practiceMatches, practiceOrigin, practiceStory, STRIP_WINDOW, type Cell } from "./practices.ts";

/** A text with `backticked` spans set as code. */
function inlineCode(text: string): Markup {
  const parts = text.split("`");
  return html`${parts.map((part, i) => (i % 2 === 1 ? html`<code>${part}</code>` : part))}`;
}

/** A record or commit a practice cites, linked into the Journal when the page holds that record. */
function citationLink(id: string, records: readonly JournalRecord[]): Markup {
  const held = records.some((r) => r.id === id);
  if (citationKind(id) === "commit") return html`<code class="citation" data-citation="commit">${id}</code>`;
  return held ? html`<a class="related-link citation" href="#journal-${slug(id)}">${id}</a>` : html`<code class="citation" title="not in this reading's window">${id}</code>`;
}

function practiceName(state: ShellState, id: string): Markup {
  const practice = state.practices.practices.find((p) => p.id === id);
  return html`<a class="related-link" href="#${practiceId(id)}">${practice?.name ?? id}</a>${practice?.kernel ? html` <span class="quiet">kernel</span>` : null}`;
}

/* --------------------------------------------------------------- story */

function renderStory(state: ShellState): Markup {
  const story = practiceStory(state);
  const homes = story.components.filter((c) => c.practices.length > 0);
  const bare = story.components.filter((c) => c.practices.length === 0);
  return html`<section class="practice-story" data-field="practice-story" aria-labelledby="practice-story-head">
    <h3 id="practice-story-head" class="story-head">What this project practices</h3>
    <p class="section-lead" data-field="practice-summary">${inlineCode(story.summary)}</p>
    ${story.when.length === 0
      ? null
      : html`<h4 class="story-subhead">When you… → follow…</h4>
        <ul class="when-list" data-field="when-you">${story.when.map(
          (line) => html`<li data-kind="${line.kind}"><span class="when">${inlineCode(line.when)}</span> <span class="arrow" aria-hidden="true">→</span> <span class="follow">${line.practices.map((id, i) => html`${i > 0 ? ", " : ""}${practiceName(state, id)}`)}</span></li>`,
        )}</ul>`}
    <h4 class="story-subhead">Where they live</h4>
    <ul class="home-list" data-field="practice-homes">
      ${homes.map((c) => html`<li><a class="related-link" href="#${componentId(c.folder)}">${c.name}</a> <span class="quiet"><code>${c.folder}</code></span>: ${c.practices.map((id, i) => html`${i > 0 ? ", " : ""}${practiceName(state, id)}`)}</li>`)}
      ${story.kernel.length === 0 ? null : html`<li data-field="kernel-practices">From Coherence, the kernel: ${story.kernel.map((id, i) => html`${i > 0 ? ", " : ""}${practiceName(state, id)}`)}</li>`}
      ${bare.length === 0 ? null : html`<li class="quiet" data-field="bare-components">No practice of their own: ${bare.map((c, i) => html`${i > 0 ? ", " : ""}<a class="related-link" href="#${componentId(c.folder)}">${c.name}</a>`)}</li>`}
    </ul>
    ${renderUnpracticed(state, story)}
  </section>`;
}

function renderUnpracticed(state: ShellState, story: ReturnType<typeof practiceStory>): Markup | null {
  if (story.unpracticed.length === 0 && story.uncited.length === 0) return null;
  const harvest = state.practices.practices.find((p) => p.name === "harvest practices");
  return html`<h4 class="story-subhead">No practice yet</h4>
    <ul class="unpracticed-list" data-field="unpracticed">
      ${story.unpracticed.slice(0, 8).map((u) => html`<li><a class="related-link" href="#${componentId(u.folder)}">${u.name}</a>: ${plural(u.records.length, "defect or wall on record", "defects and walls on record")} and no practice of its own (${u.records.slice(0, 4).map((r, i) => html`${i > 0 ? ", " : ""}${citationLink(r.id, state.journal.records)}`)})</li>`)}
      ${story.uncited.length === 0 ? null : html`<li>${plural(story.uncited.length, "defect no pitfall cites yet", "defects no pitfall cites yet")}: ${story.uncited.slice(-6).map((r, i) => html`${i > 0 ? ", " : ""}${citationLink(r.id, state.journal.records)}`)}${story.uncited.length > 6 ? html` <span class="quiet">and ${story.uncited.length - 6} more</span>` : null}</li>`}
    </ul>
    ${harvest === undefined ? null : html`<p class="quiet">Each is material for a pitfall or a new practice: ${practiceName(state, harvest.id)} says how to keep one.</p>`}`;
}

/* ------------------------------------------------------------ attention */

function renderPracticeAttention(state: ShellState): Markup | null {
  const items = attention(state);
  if (items.length === 0) return null;
  return html`<section class="practice-attention" data-field="practice-attention" aria-labelledby="practice-attention-head">
    <h3 id="practice-attention-head" class="story-head">Needs attention (${items.length})</h3>
    <ul class="attention-list">${items.map(
      (item) => html`<li data-attention="${item.kind}"><span class="label">${item.kind}</span> ${practiceName(state, item.practice)}: ${item.text}</li>`,
    )}</ul>
  </section>`;
}

/* ---------------------------------------------------------------- cards */

const CELL_WORD: Record<Cell, string> = {
  evidenced: "done, with its evidence",
  claimed: "marked done without the evidence it names",
  done: "done",
  deviated: "deviated",
  skipped: "skipped",
  absent: "not in the version enacted",
};

function renderStrip(cells: ReturnType<typeof adherence>[number]["cells"]): Markup {
  if (cells.length === 0) return html`<span class="strip quiet" data-field="strip">never enacted</span>`;
  return html`<span class="strip" data-field="strip" role="img" aria-label="${cells.map((c) => CELL_WORD[c.cell]).join(", ")}">${cells.map(
    (c) => html`<span class="cell" data-cell="${c.cell}" title="${stamp(c.at)} ${c.enactment}: ${CELL_WORD[c.cell]}${c.note ? ` (${c.note})` : ""}"></span>`,
  )}</span>`;
}

/** The reasons a step was deviated from or skipped: the three most frequent shown, the rest one click away. */
function renderReasons(reasons: ReturnType<typeof adherence>[number]["reasons"]): Markup {
  const line = (r: (typeof reasons)[number]): Markup => html`<li><span class="label">${r.result}${r.count > 1 ? ` ×${r.count}` : ""}</span> ${r.text}</li>`;
  const shown = reasons.slice(0, 3);
  const rest = reasons.slice(3);
  return html`<ul class="reasons">${shown.map(line)}</ul>${rest.length === 0 ? null : html`<details class="more-reasons"><summary class="quiet">${plural(rest.length, "more reason", "more reasons")}</summary><ul class="reasons">${rest.map(line)}</ul></details>`}`;
}

function renderSteps(practice: ScopePractice, state: ShellState): Markup {
  const steps = adherence(practice, state.journal.records);
  return html`<ol class="practice-steps">${steps.map(
    (step) => html`<li data-amend="${step.amendmentSuggested ? "true" : "false"}">
      <div class="step-line"><span class="step-text">${step.text}</span>${renderStrip(step.cells)}</div>
      ${step.leaves === undefined ? null : html`<p class="quiet leaves"><span class="label">leaves</span> ${step.leaves}</p>`}
      ${step.amendmentSuggested ? html`<p class="amend" data-field="amendment-suggested">Amendment suggested: deviated from repeatedly in the latest enactments.</p>` : null}
      ${step.reasons.length === 0 ? null : renderReasons(step.reasons)}
    </li>`,
  )}</ol>`;
}

function renderEnactmentList(practice: ScopePractice, state: ShellState): Markup {
  const mine = enactmentsOf(state.journal.records, practice.id).reverse();
  // The page's journal window keeps a practice's latest enactments; the spec model counts every one, so the rest are said, never dropped.
  const left = Math.max(0, practice.enactments - mine.length);
  if (mine.length === 0 && left === 0) return html`<p class="quiet" data-field="enactment-list">Never enacted.</p>`;
  return html`<details class="record" data-field="enactment-list">
    <summary>Enacted ${plural(mine.length + left, "time", "times")}${left === 0 ? "" : `; the latest ${mine.length} on this page`}</summary>
    ${left === 0
      ? null
      : state.connection?.mode === "live"
        ? html`<p class="quiet history" data-field="enactments-left">${plural(left, "earlier enactment is", "earlier enactments are")} not loaded yet. <button type="button" class="history-load" data-history="journal">Load earlier journal records</button></p>`
        : html`<p class="quiet" data-field="enactments-left">${plural(left, "earlier enactment is", "earlier enactments are")} not embedded in this page; <code>journal --kind enactment</code> lists every one.</p>`}
    <ul class="enactment-list">${mine.map((e) => {
      const outcomes = Object.values(e.results);
      const tally = (r: string): number => outcomes.filter((o) => o.result === r).length;
      return html`<li><a class="related-link" href="#journal-${slug(e.id)}">${stamp(e.at)}</a> ${e.agent} <span class="quiet">(${shortSession(e.session)}) · version ${e.version} · fired by ${e.trigger}</span> · ${tally("done")} of ${outcomes.length} done${tally("deviated") > 0 ? `, ${tally("deviated")} deviated` : ""}${tally("skipped") > 0 ? `, ${tally("skipped")} skipped` : ""}</li>`;
    })}</ul>
  </details>`;
}

function renderPractice(practice: ScopePractice, state: ShellState): Markup {
  const origin = practiceOrigin(practice, state.journal.records);
  const held = origin.versions.reduce((sum, v) => sum + v.enactments, 0);
  return html`<article class="entry practice" id="${practiceId(practice.id)}" data-state="${practice.state}" data-kernel="${practice.kernel ? "true" : "false"}">
    <div class="margin">
      <h3 class="headword"><a href="#${practiceId(practice.id)}">${practice.name}</a></h3>
      <p class="status">${practice.state}${practice.kernel ? " · kernel" : practice.reach === "internal" ? " · internal" : ""}</p>
      <p class="defined-by"><code>${practice.kernel ? practice.id : practice.file}</code></p>
    </div>
    <div class="body">
      <p class="definition">${practice.sentence}</p>
      <p class="triggers" data-field="triggers"><span class="label">fires</span> ${practice.triggers.map((t, i) => html`${i > 0 ? " · " : ""}${inlineCode(t.kind === "command" ? `\`${t.words}\`` : t.kind === "edit" ? `edit \`${t.glob}\`${t.adding ? ` adding \`${t.adding}\`` : ""}` : "on purpose")}`)}</p>
      ${renderSteps(practice, state)}
      ${practice.pitfalls.length === 0 ? null : html`<div class="pitfalls" data-field="pitfalls"><p class="label">Pitfalls, each witnessed</p><ul>${practice.pitfalls.map((pf) => html`<li>${pf.text.replace(/\s*\([^()]*\)\s*$/, "")} ${pf.cites.map((id, i) => html`${i > 0 ? ", " : ""}${citationLink(id, state.journal.records)}`)}</li>`)}</ul></div>`}
      <p class="origin" data-field="origin"><span class="label">learned from</span> ${origin.learnedFrom === "" ? "nothing cited" : origin.learnedFrom}${practice.learned.length === 0 ? null : html` (${practice.learned.map((id, i) => html`${i > 0 ? ", " : ""}${citationLink(id, state.journal.records)}`)})`}${origin.versions.length > 1 ? html`; <span class="label">versions enacted</span> ${origin.versions.map((v) => `${v.version} ×${v.enactments}`).join(" → ")}${held < practice.enactments ? ` (of the ${held} enactments on this page)` : ""}` : null}${origin.amendments.length === 0 ? null : html`; <span class="label">amended by</span> ${origin.amendments.map((d, i) => html`${i > 0 ? ", " : ""}${citationLink(d.id, state.journal.records)}`)}`}</p>
      ${practice.invariants.length === 0 ? null : html`<p class="quiet"><span class="label">serves</span> ${practice.invariants.map((name, i) => {
        const slash = name.lastIndexOf("/");
        const component = slash === -1 ? practice.component : name.slice(0, slash);
        const invariant = slash === -1 ? name : name.slice(slash + 1);
        return html`${i > 0 ? ", " : ""}<a class="related-link" href="#${invariantId(component, invariant)}">${invariant}</a>`;
      })}</p>`}
      ${practice.because === undefined ? null : html`<p class="because quiet"><span class="label">because</span> ${practice.because}</p>`}
      ${renderEnactmentList(practice, state)}
    </div>
  </article>`;
}

export function renderPracticesTools(state: ShellState): Markup {
  return html`<div class="view-tools">
    <label class="search">
      <span class="label">Search</span>
      <input type="search" data-search value="${state.practicesView.query}" placeholder="practice, step, pitfall, trigger, or component" autocomplete="off" spellcheck="false">
    </label>
  </div>`;
}

export function renderPracticesResults(state: ShellState): Markup {
  const query = state.practicesView.query;
  const shown = state.practices.practices.filter((p) => practiceMatches(p, query));
  const legend = html`<p class="quiet strip-legend" data-field="strip-legend">Each step's strip shows its latest ${STRIP_WINDOW} enactments, oldest first: <span class="cell" data-cell="evidenced"></span> done with its evidence, <span class="cell" data-cell="done"></span> done, <span class="cell" data-cell="claimed"></span> claimed without the evidence it names, <span class="cell" data-cell="deviated"></span> deviated, <span class="cell" data-cell="skipped"></span> skipped, <span class="cell" data-cell="absent"></span> not in the version enacted.</p>`;
  return html`${query === "" ? renderStory(state) : null}
    ${query === "" ? renderPracticeAttention(state) : null}
    ${state.practices.practices.length === 0 ? null : legend}
    ${shown.length === 0 && state.practices.practices.length > 0 ? html`<p class="absence">No practice matches “${query}”.</p>` : null}
    ${shown.map((p) => renderPractice(p, state))}`;
}
