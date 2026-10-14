/**
 * The browser side of the Scope reading.
 *
 * The page holds one `ShellState`. Every change to what the reader sees is a change to that state
 * followed by a render; nothing is written to the DOM that a render could not
 * regenerate. The only other places a value lives are the search field and
 * the filter selects, whose current values are copied into the active view's
 * state on every input or change event. The hash is read, never written to
 * the state: a hash resolves to a view and a card on load and on change.
 *
 * The state arrives one of two ways. A snapshot carries it inline, and the
 * page never asks for anything. The fixed shell the warm server serves
 * carries none: the page fetches the first load with the token from its own
 * address (sent as a header, never in a later address), then follows the
 * server's event stream, merging each update into the state (updates.ts) and
 * rendering again. When the stream ends the page says it is disconnected and
 * reconnects with backoff, resuming from cursors derived from the state it
 * holds, so nothing appended while it was away is lost or held twice.
 *
 * This file is stripped of types and inlined into the page together with the
 * modules it imports, so it must not rely on anything outside them.
 */

import { componentOfHash, journalId, resolveHash } from "./derive.ts";
import type { JournalKind, JournalRecord, LifecycleState, RecordedSite, RunRecord, ShellState } from "./model.ts";
import { renderMasthead, renderShell, renderViewResults } from "./shell.ts";
import { FLOW_NONE_ID, flowDefaultSelection, flowExpanded, flowKeyAction, flowOf, isFlowId } from "./structure-flow.ts";
import { applyUpdate, cursorsOf, mergeJournal, mergeRuns, mergeSites, parseStream } from "./updates.ts";

/** The state a snapshot carries inline; undefined in the shell, whose state the warm server serves. */
function readEmbeddedState(): ShellState | undefined {
  const text = document.getElementById("scope-state")?.textContent ?? "";
  return text.trim() === "" ? undefined : (JSON.parse(text) as ShellState);
}

/** How long a stream may stay silent before the page counts it lost; the server sends a keepalive far more often. */
const STREAM_SILENCE_MS = 45_000;
/** The longest wait between reconnection attempts. */
const RECONNECT_MAX_MS = 15_000;
/** How many records one history page asks for. */
const HISTORY_PAGE = 200;

/** What a live page can ask its server for, beyond the stream: pages of history and single records. */
interface LiveAccess {
  get(path: string): Promise<unknown>;
}

/** The query field of the active view. */
function setQuery(state: ShellState, value: string): void {
  switch (state.activeView) {
    case "lexicon":
      state.lexicon.query = value;
      return;
    case "components":
      state.components.query = value;
      return;
    case "invariants":
      state.invariants.query = value;
      return;
    case "practices":
      state.practicesView.query = value;
      return;
    case "runs":
      state.runsView.query = value;
      return;
    case "journal":
      state.journalView.query = value;
      return;
    default:
      return;
  }
}

/** A filter of the active view. Unknown names are ignored. */
function setFilter(state: ShellState, name: string, value: string): void {
  if (state.activeView === "invariants") {
    if (name === "state") state.invariants.state = value as LifecycleState | "";
    if (name === "component") state.invariants.component = value;
  } else if (state.activeView === "journal") {
    if (name === "kind") state.journalView.kind = value as JournalKind | "";
    if (name === "agent") state.journalView.agent = value;
    if (name === "session") state.journalView.session = value;
  }
}

/**
 * Show one state and handle every reader interaction on it. Returns `update`,
 * which a live page calls after merging an update: the masthead and the
 * active view's results render again, and the whole shell when no control
 * of the page holds focus, so a reader typing a query is never interrupted.
 */
function start(root: HTMLElement, state: ShellState, live: LiveAccess | undefined): { update: () => void } {
  const renderAll = (): void => {
    document.title = `${state.project} Scope`;
    root.innerHTML = renderShell(state).text;
  };

  const update = (): void => {
    const focused = document.activeElement;
    const typing = focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement || focused instanceof HTMLTextAreaElement;
    if (!typing || !root.contains(focused)) {
      const scroll = window.scrollY;
      renderAll();
      window.scrollTo({ top: scroll, behavior: "instant" });
      return;
    }
    document.title = `${state.project} Scope`;
    const masthead = root.querySelector<HTMLElement>(".masthead");
    if (masthead !== null) masthead.outerHTML = renderMasthead(state).text;
    renderResults();
  };

  /**
   * Fetch records the page has not loaded (a page of history, a search, one
   * record), merge them as older records, and render. Resolves to the answer,
   * or undefined when the fetch failed, which the button says.
   */
  const loadHistory = async (button: HTMLButtonElement, path: string, store: "journal" | "runs"): Promise<{ records: (JournalRecord | RunRecord)[]; more: boolean } | undefined> => {
    if (live === undefined) return undefined;
    button.disabled = true;
    try {
      const answer = (await live.get(path)) as { records: (JournalRecord | RunRecord)[]; more: boolean };
      if (store === "journal") mergeJournal(state, answer.records as JournalRecord[], true);
      else mergeRuns(state, answer.records as RunRecord[], true);
      return answer;
    } catch (error) {
      button.disabled = false;
      button.textContent = `Could not load (${error instanceof Error ? error.message : String(error)}); try again`;
      return undefined;
    }
  };

  /**
   * Page back from where the last page stopped: first the server's hint (the
   * oldest record of the first load's latest window), then the oldest record
   * each page returned; the server answers oldest first.
   */
  const pageBack = async (button: HTMLButtonElement, store: "journal" | "runs"): Promise<void> => {
    const connection = state.connection;
    const before = connection?.history?.[store] ?? "";
    const answer = await loadHistory(button, `/api/${store}?before=${encodeURIComponent(before)}&limit=${HISTORY_PAGE}`, store);
    if (answer === undefined) return;
    const oldest = answer.records[0] as { at: string; id?: string; session?: string } | undefined;
    if (connection !== undefined) connection.history = { ...connection.history, [store]: !answer.more || oldest === undefined ? "" : `${oldest.at}~${oldest.id ?? oldest.session ?? ""}` };
    update();
  };

  const renderResults = (): void => {
    const results = root.querySelector<HTMLElement>("[data-results]");
    if (results === null) return renderAll();
    results.innerHTML = renderViewResults(state).text;
  };

  const showView = (view: string): void => {
    if (view === state.activeView) return;
    state.activeView = view;
    renderAll();
  };

  /** Land on what the hash names: its view first, then the card. */
  const followHash = (): void => {
    const target = resolveHash(state, location.hash);
    if (target === undefined) return;
    if (target.id !== undefined) {
      const component = componentOfHash(state, target.id);
      if (component !== undefined) state.components.selected = component.folder;
      if (isFlowId(target.id)) state.structure.selected = target.id;
    } else if (target.view === "structure") delete state.structure.selected;
    const changed = target.view !== state.activeView;
    state.activeView = target.view;
    if (changed || target.id !== undefined) renderAll();
    // A card scrolls into view; a map element does not, since the map is already where Structure opens and the inspector shows it.
    const landed = target.id === undefined ? null : document.getElementById(decodeURIComponent(target.id));
    if (landed !== null && landed.closest(".flow-svg") === null) landed.scrollIntoView();
    revealSelection(false);
  };

  /**
   * Bring what is selected on the map into view: the canvas scrolls sideways
   * to center it when it is outside the canvas's width (a narrow window, or a
   * broken mark past the right edge); after a reader's click the page also
   * scrolls, as little as it can, so the map element is on screen. A load
   * never scrolls the page, only the canvas.
   */
  const revealSelection = (page: boolean): void => {
    if (state.activeView !== "structure") return;
    const canvas = root.querySelector<HTMLElement>(".flow-canvas");
    const id = state.structure.selected ?? (state.structure.preview.length > 0 ? undefined : flowDefaultSelection(flowOf(state)));
    if (canvas === null || id === undefined || id === FLOW_NONE_ID) return;
    const target = canvas.querySelector<SVGElement>(`svg [id="${id}"]`) ?? canvas.querySelector<SVGElement>(`svg [data-structure-select="${id}"]`);
    if (target === null) return;
    const box = target.getBoundingClientRect();
    const frame = canvas.getBoundingClientRect();
    if (box.left < frame.left || box.right > frame.right) canvas.scrollLeft += box.left + box.width / 2 - (frame.left + frame.width / 2);
    if (!page) return;
    // Below the side-by-side width the inspector is a sheet over the lower part of the screen: keep the element above it.
    const sheet = window.matchMedia("(max-width: 63.99rem)").matches;
    const shown = target.getBoundingClientRect();
    const floor = sheet ? window.innerHeight * 0.42 : window.innerHeight - 8;
    if (shown.top < 8 || shown.bottom > floor) window.scrollBy({ top: shown.top - (sheet ? 72 : window.innerHeight / 3), behavior: "instant" });
  };

  /**
   * Select a story in the Structure flow, opening the inspector beside the
   * map; selecting what is already selected (the default story included), the
   * close button, and Escape clear it to nothing selected, which closes the
   * inspector. The hash follows so it can be linked.
   */
  const selectStory = (id: string): void => {
    const current = state.structure.selected ?? (state.structure.preview.length > 0 ? undefined : flowDefaultSelection(flowOf(state)));
    const closing = id === "" || id === FLOW_NONE_ID || current === id;
    if (closing && state.structure.selected === FLOW_NONE_ID) return;
    state.structure.selected = closing ? FLOW_NONE_ID : id;
    history.replaceState(null, "", `#${state.structure.selected}`);
    renderResults();
    if (!closing) revealSelection(true);
    const again = closing
      ? root.querySelector<HTMLElement | SVGElement>(`[data-structure-select="${current ?? ""}"]`) ?? root.querySelector<HTMLElement>(".flow-canvas")
      : root.querySelector<HTMLElement | SVGElement>(`[id="${id}"][data-structure-select]`) ?? root.querySelector<HTMLElement | SVGElement>(`svg [data-structure-select="${id}"]`);
    again?.focus({ preventScroll: true });
  };

  root.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.hasAttribute("data-search")) return;
    setQuery(state, target.value);
    renderResults();
  });

  root.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const name = target.dataset["filter"];
    if (name === undefined) return;
    setFilter(state, name, target.value);
    renderResults();
  });

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const older = target.closest<HTMLButtonElement>("button[data-history]");
    if (older !== null) {
      const store = older.dataset["history"] === "runs" ? "runs" : "journal";
      void pageBack(older, store);
      return;
    }

    const search = target.closest<HTMLButtonElement>("button[data-history-search]");
    if (search !== null) {
      const query = state.journalView.query.trim();
      void loadHistory(search, `/api/journal?q=${encodeURIComponent(query)}&limit=${HISTORY_PAGE}`, "journal").then((answer) => answer !== undefined && update());
      return;
    }

    const sites = target.closest<HTMLButtonElement>("button[data-load-sites]");
    if (sites !== null && live !== undefined) {
      const run = sites.dataset["loadSites"] ?? "";
      const component = sites.dataset["component"] ?? "";
      const name = sites.dataset["name"] ?? "";
      sites.disabled = true;
      void live
        .get(`/api/sites?run=${encodeURIComponent(run)}&component=${encodeURIComponent(component)}&name=${encodeURIComponent(name)}`)
        .then((answer) => {
          if (mergeSites(state, run, component, name, (answer as { sites: RecordedSite[] }).sites)) update();
        })
        .catch((error: unknown) => {
          sites.disabled = false;
          sites.textContent = `Could not load (${error instanceof Error ? error.message : String(error)}); try again`;
        });
      return;
    }

    const one = target.closest<HTMLButtonElement>("button[data-load-record]");
    if (one !== null) {
      const id = one.dataset["loadRecord"] ?? "";
      void loadHistory(one, `/api/record?id=${encodeURIComponent(id)}`, "journal").then((answer) => {
        const record = answer?.records[0] as JournalRecord | undefined;
        if (record === undefined) return;
        update();
        location.hash = `#${journalId(record)}`;
      });
      return;
    }

    const tab = target.closest<HTMLElement>("[role=tab][data-view]");
    if (tab !== null) {
      const view = tab.dataset["view"];
      if (view !== undefined && view !== state.activeView) {
        showView(view);
        history.replaceState(null, "", `#${view}`);
        root.querySelector<HTMLElement>("[role=tab][aria-selected=true]")?.focus();
      }
      return;
    }

    const expand = target.closest<Element>("[data-structure-expand]");
    if (expand !== null) {
      // One level of the component tree at a time: open or close this component in place.
      const folder = expand.getAttribute("data-structure-expand") ?? "";
      const open = flowExpanded(state);
      if (open.has(folder)) open.delete(folder);
      else open.add(folder);
      state.structure.expanded = [...open].sort();
      renderResults();
      return;
    }

    const story = target.closest<Element>("[data-structure-select]");
    if (story !== null) {
      selectStory(story.getAttribute("data-structure-select") ?? "");
      return;
    }

    const select = target.closest<HTMLElement>("[data-select-component]");
    if (select !== null) {
      const folder = select.dataset["selectComponent"];
      if (folder === undefined || state.components.selected === folder) delete state.components.selected;
      else state.components.selected = folder;
      renderResults();
      return;
    }

    // A link into a card must land on it even when a query has hidden it or
    // another view holds it: clear the active view's query, then let the
    // hash change resolve the view.
    const link = target.closest<HTMLAnchorElement>("a[href^='#']");
    if (link !== null) {
      const hash = link.getAttribute("href") ?? "";
      const resolved = resolveHash(state, hash);
      if (resolved === undefined) return;
      if (resolved.view === state.activeView) {
        setQuery(state, "");
        renderResults();
      }
      if (hash === location.hash) {
        // Same hash again fires no hashchange; follow it by hand.
        event.preventDefault();
        followHash();
      }
    }
  });

  // Escape closes the Structure inspector wherever focus is.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || state.activeView !== "structure" || state.structure.selected === FLOW_NONE_ID) return;
    const action = flowKeyAction({ key: event.key, select: undefined, button: false });
    if (action === undefined) return;
    event.preventDefault();
    selectStory(action.select);
  });

  root.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof Element && target.hasAttribute("data-structure-select")) {
      const action = flowKeyAction({ key: event.key, select: target.getAttribute("data-structure-select") ?? undefined, button: target instanceof HTMLButtonElement });
      if (action === undefined || event.key === "Escape") return;
      event.preventDefault();
      selectStory(action.select);
      return;
    }
    if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "tab") return;
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    const ids = state.views.map((v) => v.id);
    const current = ids.indexOf(state.activeView);
    if (current === -1 || ids.length < 2) return;
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = event.key === "Home" ? ids[0] : event.key === "End" ? ids[ids.length - 1] : ids[(current + step + ids.length) % ids.length];
    if (next === undefined) return;
    showView(next);
    history.replaceState(null, "", `#${next}`);
    root.querySelector<HTMLElement>("[role=tab][aria-selected=true]")?.focus();
    event.preventDefault();
  });

  window.addEventListener("hashchange", followHash);

  renderAll();
  followHash();
  return { update };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A failure of the page itself, put where the reader sees it: a banner at the
 * top of the root, replacing the waiting line if one is all the page shows.
 * A drawing failure is never read as a lost connection, and never caught and
 * kept where nothing shows it, so a page that cannot draw says so instead of
 * waiting forever.
 */
function showFailure(root: HTMLElement, error: unknown): void {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/[<&>]/g, "");
  root.querySelector(".connection-waiting")?.remove();
  let banner = root.querySelector<HTMLElement>("[data-failure]");
  if (banner === null) {
    banner = document.createElement("div");
    banner.className = "absence page-failure";
    banner.setAttribute("data-failure", "");
    banner.setAttribute("role", "alert");
    root.prepend(banner);
  }
  banner.innerHTML = `<p><strong>Scope could not draw this reading.</strong> ${message}</p><p>The reading reached this page and drawing it failed: a fault in Coherence's page, not in the warm server or the project. Reload to try again, and report it with this message.</p>`;
}

/** Run one drawing; on failure, show it and say so, so the caller stops instead of retrying what will fail the same way. */
function drawn(root: HTMLElement, draw: () => void): boolean {
  try {
    draw();
    return true;
  } catch (error) {
    showFailure(root, error);
    return false;
  }
}

/**
 * Follow the warm server: fetch the first load, then read the event stream
 * until it ends, merging each update and rendering; when it ends, say so and
 * reconnect with backoff (1, 2, 4, 8, then every 15 s), resuming from the
 * cursors of the state the page holds. A restarted server that answers on
 * the same address resumes the page where it stopped.
 */
async function follow(root: HTMLElement, token: string): Promise<void> {
  const headers = { authorization: `Bearer ${token}` };
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(path, { headers, cache: "no-store" });
    if (!response.ok) throw new Error(response.status === 401 ? "the server refused this page's token" : `the server answered ${response.status}`);
    return response.json();
  };
  let state: ShellState | undefined;
  let shown: { update: () => void } | undefined;
  let attempt = 0;
  for (;;) {
    let reason = "the stream ended";
    try {
      if (state === undefined) {
        const first = (await get("/api/state")) as { state: ShellState; version: string; history: { journal?: string; runs?: string } };
        state = first.state;
        state.connection = { mode: "live", status: "connecting", version: first.version, history: first.history };
        const live = state;
        if (!drawn(root, () => (shown = start(root, live, { get })))) return;
      }
      const held: ShellState = state;
      const cursors = cursorsOf(held);
      const query = new URLSearchParams({ journal: cursors.journal, runs: cursors.runs, work: cursors.work, version: held.connection?.version ?? "" });
      const watchdog = new AbortController();
      let silence = setTimeout(() => watchdog.abort(), STREAM_SILENCE_MS);
      const response = await fetch(`/api/events?${query.toString()}`, { headers, cache: "no-store", signal: watchdog.signal });
      if (!response.ok || response.body === null) throw new Error(response.status === 401 ? "the server refused this page's token" : `the server answered ${response.status}`);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(silence);
        silence = setTimeout(() => watchdog.abort(), STREAM_SILENCE_MS);
        const parsed = parseStream(buffer + value);
        buffer = parsed.rest;
        let changed = false;
        for (const event of parsed.events) {
          const data: unknown = JSON.parse(event.data);
          if (event.event === "ready") {
            attempt = 0;
            held.connection = { ...held.connection, mode: "live", status: "live", version: (data as { version: string }).version };
            delete held.connection.attempt;
            delete held.connection.reason;
            changed = true;
          } else changed = applyUpdate(held, event.event, data) || changed;
        }
        if (changed && !drawn(root, () => shown?.update())) return;
      }
      clearTimeout(silence);
    } catch (error) {
      reason = error instanceof Error && error.name !== "AbortError" ? error.message : "the server went quiet";
      if (reason === "Failed to fetch" || reason === "network error" || reason.startsWith("NetworkError")) reason = "the server is not answering";
    }
    attempt += 1;
    if (state !== undefined) {
      state.connection = { ...state.connection, mode: "live", status: "disconnected", attempt, reason };
      if (!drawn(root, () => shown?.update())) return;
    } else {
      root.innerHTML = `<p class="absence connection-waiting" data-connection="disconnected">Could not load the reading from the warm server (${reason.replace(/[<&>]/g, "")}); retrying, attempt ${attempt}.</p>`;
    }
    await sleep(Math.min(RECONNECT_MAX_MS, 1000 * 2 ** Math.min(attempt - 1, 4)));
  }
}

function boot(): void {
  const root = document.getElementById("scope-root");
  if (root === null) throw new Error("Scope: the root element is missing from this page.");
  // Whatever fails later, in a handler or a promise nothing awaits, is shown on the page, not only in a console.
  addEventListener("error", (event) => showFailure(root, event.error ?? event.message));
  addEventListener("unhandledrejection", (event) => showFailure(root, event.reason));
  const embedded = readEmbeddedState();
  if (embedded !== undefined) {
    embedded.connection = { mode: "snapshot", status: "live" };
    drawn(root, () => start(root, embedded, undefined));
    return;
  }
  const token = new URLSearchParams(location.search).get("token");
  if (token === null) {
    root.innerHTML = '<p class="absence">This page is the Scope shell and carries no state. Open it through <code>coherence scope</code>, which prints its address with the token.</p>';
    return;
  }
  root.innerHTML = '<p class="absence connection-waiting" data-connection="connecting">Connecting to the warm server…</p>';
  void follow(root, token);
}

boot();

export {};
