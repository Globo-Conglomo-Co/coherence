# The Scope shell

Scope is the reading: one surface that projects the model for a human, in
views. Seven views ship: Lexicon, Components, Structure, Invariants, Practices, Runs, and
Journal.

## Structure

The shell is a function of one state value. `src/readings/scope/model.ts`
holds the model: a lexicon (concepts, metaphors, and, per project, rejected
names, trust levels, rulings, candidate overloads, uncertain terms), a layer
(a lexicon present, or an absence with its reason), the spec model as
`loadSpecModel` returns it (components with their entrances, invariants with
their lifecycle state, counts, and the adapter's grade ladder), the run
records, the journal records with the work orders (folded by the journal's
own loader from their records, so each carries its current state) when
`.coherence/work` exists, the component interfaces as the language adapter
read them, and per view the reader's query, filters, and selection.

`build.ts` loads those truths once and embeds the state as JSON in
`.coherence/scope/_scope.html` with the styles and one inline script. Same inputs in,
byte-identical page out. With `--root <project>` it builds over another
project: that root's specs, runs, journal, and lexicon (named under
`lexicon` in `coherence.config.json`, else `lexicon.json`) become the
domain layer beneath Coherence's own.

The page embeds a bounded window of the two stores that grow every session:
the latest run records plus every run holding some enforcement's latest
entry, and the latest journal records plus every open escalation and what
those records point at. Every verdict derived from the window equals the one
derived from every record, and the count left out is shown; the whole journal
is one `journal` command away. The agent query builds without the window.

In the browser, `page.ts` renders the embedded state with `renderShell`, a
pure function from state to markup. Every reader change is a state change
followed by a render; nothing shown is stored. The latest verdict per
enforcement, the kept-from-an-earlier-run marks, reliance, open escalations,
the Structure map, and every count are derived on each render, never
embedded.

## The views

**Components** is the tree with intent, counts per lifecycle state, and a
mass line reserved for the economy's measurement (`mass: not measured` until
it exists). Selecting a component shows its invariants.

**Structure** is one map of what the system is made of and how work flows
through it, drawn the way transit maps and process drawings are: journeys,
not connections. `flowOf` in `structure-flow.ts` is the one pure
derivation, read by the SVG in `structure-flow-view.ts` and by
`query structure`; `structure-measure.ts` reads the rendered SVG back.

- Evidence. The map states what it stands on: static and computed, resolved
  references through the language adapter, declared entrances, and
  invariants. Observed runtime behavior is not shown (the observation seam,
  `observedEvidence` in `src/observation/record.ts`, is not drawn yet). When
  the page was built without the adapter (a test, a scaffold preview,
  `--no-interfaces`), only the references the latest runs recorded to
  chokepoints and protected things are known, and the map says plain
  component interfaces are unknown.
- Component interfaces. `component-interfaces.ts` resolves every exported
  top-level declaration of every non-test source file and asks the adapter
  for its references; each non-test site in another component adds that
  symbol to the component interface from the caller to the callee. Every
  component interface is on the map, caller to callee, and none is implied
  away: along a structural route, as a stub to a core dependency, at rest
  when a chokepoint, a crossing or a bypass stands on it (a thin grey line,
  dashed red when broken), and otherwise drawn faint, dashed, when a
  selection reaches it.
- Health. A strip above the map counts every invariant by its one verdict
  (`invariantVerdict` in `derive.ts`): enforced and verified (the spec
  model's invariants), requirements, structural defects, requirements whose
  chokepoint check found bypasses, and open escalations. Each count is a
  selection; its inspector lists the set, and a project with nothing
  enforced says so in words on the map. Every interface identifier is drawn
  in its invariant's state (solid verified, dashed outline requirement, red
  broken), every component carries its worst verdict as a bar inside its
  box, and a component with a broken chokepoint carries a red `✕ n broken`
  button attached to its box that lists every bypass site, those inside the
  component named as inside.
- Crossings. Every crossing is drawn (`model.crossings`): on the component
  interfaces its chokepoint stands on; on the line from a route's origin
  when its chokepoint is the entrances' own handler (Coherence's hook
  entrances: `runHook` is the chokepoint of the harness crossings); else on
  its component's boundary mark, a token on the box's edge with the edge
  dashed red, counting the crossings inside it (a rail carries its own).
  Selecting a trust level lights exactly the identifiers and marks whose
  crossings carry it.
- Structural routes. With the handler's static reach read (the adapter
  records, per entrance, the component interfaces its handler's value
  references reach, through every declaration they reach), a route is the
  component that declares the entrance, the component holding its handler,
  then from each stop the heaviest interface that reach uses through a
  symbol only that stop's component calls (never a type, never a utility
  another component also calls), never into a core dependency, never back to
  a column it has left (`ROUTE_RULE`); it stops where the reach goes no
  further. Without a reach the heaviest interface is followed and the route
  says it is reference weight, not flow. Entrances share a route only when
  they share its stops and their trust: the entering side of the crossings
  whose chokepoint is their handler. A route is named for its origin, never
  lettered: at most four entrance names, one per line, and a count of the
  rest, which the route's inspector lists; a project that declares no
  entrance has its routes derived from the root component's interfaces, one
  per callee, named "via" the first component it reaches with a second line
  "reference weight" beside a hollow dashed dot. The eight routes most
  entrances take wear the eight colors, each darkened until white text on it
  reaches 4.5:1; origin text is always white. A route is one path of its own color (the validated eight-color order,
  then neutral) through the centre of each station in order; routes through
  one component meet at its station, and parallel routes run side by side at
  a fixed six-pixel offset, never merged. Every segment is horizontal,
  vertical, or at 45 degrees: a step into the next column leaves by a port on
  the right and turns in a lane of the gap; a step to the neighbouring station
  in the same column drops straight down (or up) between them; a step past a
  station in the same column turns in the column's own lane, nearest the
  stations, shortest innermost so nested lanes never cross.
- Rest and selection. The map opens on the busiest route
  (`flowDefaultSelection`, `DEFAULT_RULE`: the most reference sites along its
  component interfaces, then the most entrances, then by name), lit, with every other
  route dimmed; an absent selection means that default. Clearing the selection
  stores `structure--none`: nothing lit and every route thin and muted. Any
  deep link still selects anything.
- Core dependencies. A component called by more than half of the other
  visible components, by at least three, with at least three quarters of its
  component interfaces incoming (`CORE_RULE`), is a rail along the foot of
  the map, labelled once. Each caller's stub runs from the foot of its
  station to one shared drop per rail beside its column (the side with fewer
  tracks to cross) and down to the rail, meeting it at a joint; no route line
  or arrow reaches the rail and no route runs through it.
- Interface identifiers. Each chokepoint gets a short identifier from its
  place in the chokepoint list, `C3` for a chokepoint and `X7` for one whose
  invariant carries a crossing, drawn as a small box on each component
  interface it stands on, one keyboard-reachable button each (named "X7:
  <invariant>"); a crossing draws a dashed red trust boundary across the pipe
  through it. A core dependency's identifiers are drawn once, on its rail,
  never beside each caller. A bypass adds a `✕n` box that selects the
  interface. What an interface reveals comes from the invariants, never
  authored: the chokepoint that stands on it, that invariant's crossing, and
  the classes of data that pass; the inspector's label reads them in that
  order, else its most-referenced symbols; never a verb.
- Text. Every piece of canvas text has a priority (station names, the
  entrance names at each route's start and rail labels, the caption,
  identifiers, defect marks, proposals, column captions) and is placed at its first candidate that overlaps no
  placed text and no station, preferring places no line runs through; lower
  priority text is dropped, never overlapped, never truncated. The dropped
  keys are on the SVG's `data-dropped`. `measureSvg` computes text boxes from
  Helvetica metrics it embeds (the canvas is set in Helvetica) and counts
  overlaps, truncation, clipping, off-angle segments and crossings.
- Entrances. Each is declared in a spec's `## entrances` (see
  `docs/spec.md`) and resolved again through the adapter; its route starts at
  the declaring component, and a dispatcher's entrance is unreachable unless
  the component interface from the declaring component carries the handler.
- Placement and stability. Positions are never stored. A component's
  column is its true distance from where work enters, uncapped: the fewest
  component interfaces from a component that declares an entrance (the root
  when none does), never through a core dependency; what no entrance reaches
  is measured from a component only a core dependency calls, which stands
  where work enters, undeclared. Within a column components keep folder
  order; each asks for the row that keeps the routes reaching it from the
  column before straight (the median of where they come from) and takes it
  when the component above leaves room. A component where routes start spans
  the rows its origin lines need. A station holds its name, its role (its
  spec's intent in two lines, shortened at a clause or whole words, never an
  ellipsis), and its folder in IBM Plex Mono, embedded in the page. Stability is stable relative order:
  adding one component interface moves out of its column only what the
  interface reaches (its callee and what the callee reaches, or all its
  caller reaches when it stops the caller being a core dependency), and never
  reorders, within a column, components that keep their columns (journal
  d-41cad841, replacing the cap at two of d-1f1ce391, which made routes
  double back).
- Zoom. One level of the component tree at a time: the top level is open,
  and a component with children opens in place (its station stays for its
  own code). A closed component carries its children's interfaces at its
  edge. Source in no component's folder is its own labelled mass.
- One map, one inspector. Selection is state (`state.structure.selected`,
  an id prefixed `structure--`) and lights one story while everything else
  dims: an entrance or a route lights that route; a trust level lights the
  identifiers whose crossings carry that class of data (the security spine)
  and the interfaces they stand on; an interface identifier (its
  chokepoint's selection) lights where it stands and the routes through
  there; a component lights its direct component interfaces and keeps the
  routes through it, never everything it reaches; an interface lights
  itself. The change selection is the diff's place: `compareFlows(before,
  after)` already measures entrance added or removed, interface added,
  removed, or widened, a chokepoint gaining a bypass, a crossing added or
  removed, and a data path gaining a branch; comparing with the previous
  commit, or one the agent names, is the next slice. The page writes the
  selection to the hash, and `followHash` reads it back.
- The inspector stands beside the canvas at desktop widths (its own grid
  column, sticky, never over the map; the canvas keeps its full height and
  the shell widens while Structure is shown) and, below that, a dismissible
  sheet over the bottom of the screen for anything the reader selects; the
  default story's inspector stays in the page under the map there. It is open while something is
  selected, showing that thing; with nothing selected it shows the map's
  summary. Its close button and the `Escape` key clear the selection
  (`flowKeyAction` decides what a key does: `Enter` and `Space` activate a map
  element, `Escape` closes). An identifier's inspector shows the invariant's
  name and sentence, its component, every enforcement with its latest
  verdict, grade and enforcer, the crossing with both trust levels and their
  meanings, the refutation (witnessed, automatic, or refused by the
  language, dated), bypass sites with the two honest options, the component
  interfaces it stands on with their symbol counts, the structural routes
  through them, and its reliance: the classified reference sites of the
  latest run, owner first (a protected bypass is never a legal chokepoint
  reference, and an absent `sites` field is incomplete evidence, never
  zero).

**Invariants** shows every bullet: state, enforcement form with its latest
verdict, the chokepoint grade with the rung's enforcer, crossing over the
declared trust levels, because, refutation (witnessed, automatic from the
run, or missing), checklist, and what it lacks. A structural defect shows
its bypass sites and the two honest options: route through the chokepoint,
or escalate a retirement. Filters by state and component.

**Practices** tells the story of what the project practices before how each
practice holds. It opens with a summary in words, then the project's working
rules by what sets them off ("When you run `refute` → witness a
refutation", "When you edit `**/*.spec.md` adding `refuted:` → …", and the
practices taken up on purpose), then where the practices live (each
component with its own, the kernel practices Coherence ships, and the
components with none), then what has no practice yet: components with
defects or walls on record and no practice of their own, and defects no
pitfall cites. What needs attention follows: a step gone from an enacted
practice with no decision, a step claimed done without the evidence it
names, a step deviated from repeatedly, a candidate never enacted. Each
practice's card shows its steps with an adherence strip over its latest
twelve enactments (evidenced, done, claimed, deviated, skipped, or absent
when the version enacted lacked the step), the reasons sessions gave for
deviating, its pitfalls linked to the records that witnessed them, what it
was learned from, its versions and amendments, and its enactments. The
derivations are `practices.ts`; the journal window keeps every enactment,
every decision citing one, and every record a practice cites, so none of it
depends on the record's age. `query practice` prints the same story.

**Runs** lists the records latest first with session, agent, commit, dirty
flag, and counts; the verdicts one click away; on the latest, what the status
view keeps from earlier runs.

**Journal** is the merged timeline with kind glyphs, escalations awaiting a
human pinned at the top, a decision's rejected alternatives in the open, and
work orders when present, each the fold of its records (content, owner,
current state, history), never a state-change record shown as an order.
Filters by kind, agent, and session.

## Deep links

Every card or map id carries its view as a prefix (`component-`,
`structure-`, `invariant-`, `run-`, `journal-`, `work-`, and the lexicon's
`coherence-` and `domain-`). A hash resolves to its view by that prefix, or
names a view alone (`#runs`). Links into the retired Reliance view
(`#reliance-…`) and the retired security-spine section (`#structure-<component>-<invariant>`)
land on the map's chokepoint selection, or on the trust level a crossing
leaves when there is no chokepoint. `resolveHash` in `derive.ts` is the one
place this is decided.

## The agent query

`node src/cli.ts query <question> [args]` answers a fixed set of questions
from the same state through `buildScopePage`: `invariants <path...>`,
`relies-on <chokepoint>`, `spine`, `structure`, `status`, `component <folder>`, `order`; and
`economy <path...>`, the economy prediction (what must be loaded to change
these files safely), which goes to the economy's own closure through the
warm instrument rather than to the page state. Plain text, a few hundred
tokens at most, no query language.

`query structure` reads the component interfaces through the language
adapter and formats `flowOf`: the structural routes, each by its entrance
names (or `via <component> (derived)`), with their stops in order and the
route the map opens on, the core dependencies with the rule and their callers, the interface
identifiers with the interfaces they stand on, every interface with its
label and where it is drawn, the entrances with where each starts or why it
is unreachable, and each component's row and column.
`query spine` lists the trust levels and every crossing-bearing invariant
from `structureOf`.

## Ephemeral Structure previews

`writeStructurePreview(root, preview, outPath)` in `build.ts` is the scaffold
bridge. `StructurePreview` is exported from `derive.ts` and carries only a
component, invariant name, crossing endpoints, and optional
chokepoint/protected-thing pairs. The bridge validates the component,
duplicate name, and crossing trust levels, selects Structure initially, and
writes a deterministic page with the proposal drawn dashed on its component,
unverified. It refuses an output path inside the project root so the
generated artifact cannot change the lexicon or spec population between
otherwise identical previews. It changes no spec or run store, and the caller
cannot supply a grade, verdict, bypass count, lifecycle state, or reliance
evidence.

## Adding a view

1. Give the view a state type in `model.ts` and a field on `ShellState`.
2. Populate it in `loadState` in `build.ts`.
3. Write a pure render pair (tools and results) beside `lexicon-view.ts`,
   with card ids under a new prefix registered in `resolveHash`.
4. List it in `VIEWS` in `shell.ts` and add its cases to `renderViewTools`
   and `renderViewResults`. There is no list of browser sources to add it
   to: the bundle is every module `page.ts` imports at run time, followed to
   the end, so importing the new view where it is used is what puts it in.
5. Top-level names are one name space across the browser sources; the
   builder refuses a duplicate by name. A browser source imports names in
   braces under their exported names, by relative path; a renamed,
   namespace or default import, or one of a package or a `node:` module,
   fails the build, since the page could not resolve it.
6. Add what it must show to `check.test.ts`.
