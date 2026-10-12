# Spike: Coherence as a Claude Code mod with a warm hook process

Status: shipped as an opt-in fast path (`hooks install --host claude --mod`, see the README) on 2026-10-12; measured 2026-10-09 on Claude Code 2.1.295 and Coherence 1.7.0 plus the spike branch.

## What was built

- **`coherence hook-serve [--socket]`** (`src/lifecycle/hook-serve.ts`): one long-lived process per session that answers hook events with the same `runHook` that `coherence hook <event>` runs. Requests and answers are JSON (`{"id","op":"hook","event","input"}` → `{"id","stdout","stderr","exit","ms","verdict?"}`), one per line on stdin, and with `--socket` also as HTTP POSTs over a Unix socket in a private 0700 folder whose path is the first line it prints. It commits an event's records only once its answer is written, as the CLI commits once its stdout is accepted. It handles one event at a time, answers `stale` and exits when Coherence's code on disk changed since it loaded, exits when its parent is gone, and removes its folder on SIGTERM. It also answers `status` (the status line's text) and `scope` (the live Scope address).
- **`EditVerdict`** (`src/lifecycle/hook.ts`): an optional `onEditCheck` observer that the edit's chokepoint check calls with its verdict as data. The CLI passes none, so its output is unchanged. hook-serve returns the verdict beside the answer.
- **The mod** (`mods/coherence/`, run with `claude --plugin-dir mods/coherence`): it starts hook-serve on the session's first event and answers `classic.SessionStart`, `SubagentStart`, `UserPromptSubmit`, `PreToolUse` (the install's matcher: Bash, Edit, Write, MultiEdit, NotebookEdit), `PostToolUse`, `Stop` and `SubagentStop` with the JSON the settings hook would print, mapped onto the classic result. `claude plugin validate` is clean, and `claude plugin test mods/coherence` passes 7 tests.
- **Tests:** `src/lifecycle/hook-serve.test.ts` covers three spec bullets in `Lifecycle.spec.md`, each with a witnessed refutation: the same output and records as the CLI for a session's start, prompt, edit (pre and post), read and stop; stale code; and the socket going away on SIGTERM. `mods/coherence/tests/forward.test.tsx` covers a warm answer, the dead-process fallback, the stop digest, a refusal, and the row verdict on the terminal, desktop and vscode surfaces.
- **Benchmark:** `bench/hook-serve/run.ts` (interleaved rounds) and `summarize.ts`.

## Measurements

Every run was on battery in Low Power Mode (`pmset -g`: `powermode 1`, "Now drawing from 'Battery Power'", 69% to 59%). The machine was shared with other agents' test runs, so I recorded the load average for each run. "CLI" is the wall time to spawn `node src/cli.ts hook <event>` with the event on stdin, which is what a settings hook costs. "Warm" is the wall time of one POST over hook-serve's socket, which is what the mod waits on. Both arms ran this branch's code, interleaved round by round with the order alternating.

### 1. Protocol, small fixture (5 rounds; load average about 20 to 30)

| step | CLI (median) | warm (median) |
| --- | --- | --- |
| session start | 521 ms | 529 ms (the process's first event pays lazy loading) |
| prompt | 470 ms | 359 ms |
| edit, pre | 463 ms | 55 ms |
| edit, post (chokepoint check) | 840 ms | 264 ms |
| read, post | 569 ms | 13 ms |
| stop | 1.45 s | 619 ms |
| session (sum of medians) | 8.15 s | 2.42 s |

The CLI ranges were wide (300 ms to 1.4 s for the same step) because of the load. The warm ranges were tight.

### 2. Protocol, PostHog (4 rounds; load average 20 falling to 6)

The events are the earlier verification's: the first edit of `posthog/auth.py` adding `def authenticate(self, request):`, a repeat edit, an edit outside every leaf, a read, and a stop. Each one was sent as its tool hook pair.

| step | CLI (median, range) | warm (median, range) | saved |
| --- | --- | --- | --- |
| session start (root, pointer) | 263 ms (261–265) | 12 ms (11–16) | 251 ms |
| prompt | 257 ms (251–263) | 6 ms (6–9) | 251 ms |
| first edit, pre (first leaf entry, orient) | 3.29 s (3.23–3.72) | 3.05 s (2.99–3.17) | 241 ms |
| first edit, post | 702 ms (691–783) | 408 ms (399–412) | 294 ms |
| repeat edit, pre | 336 ms | 76 ms | 260 ms |
| repeat edit, post | 703 ms | 397 ms | 306 ms |
| edit outside every leaf, pre / post | 257 / 259 ms | 7 / 6 ms | about 250 ms each |
| read, post | 282 ms | 8 ms | 274 ms |
| stop | 19.50 s (19.07–22.87) | 19.75 s (19.50–20.52) | none |
| session (sum of medians) | 25.85 s | 23.71 s | 2.13 s |

Warm process start, from spawn to ready, is off the event path: median 260 ms. Every event exited 0 on both arms.

What this shows: the warm process removes Node's start and Coherence's module load, about 0.25 s, from every event. On PostHog's cheap events (prompt, read, edits outside a leaf) that is nearly the whole cost, so they drop from about 260 ms to under 10 ms. It does not shorten the work itself. The first leaf entry still takes 3.05 s, just over the 3 s budget. The stop after an edit takes about 19.5 s on both arms; 16 s of a 20 s CPU profile was idle, which is conjecture c-ccb3a873. That stop is far slower than the 3.5 to 3.9 s stop of a session that only read a file in the leaf.

### 3. End to end, real `claude -p` sessions on PostHog (3 interleaved pairs, Haiku; load average 7 falling to 4)

Prompt: "Use the Bash tool exactly once to run the command: `cd posthog && ls | head -n 3`. Then answer with the single word ok." The `cd` enters the posthog leaf, so the Bash `PostToolUse` carries the first-entry orient. Both arms read user settings only (d-47291537). The settings arm adds Coherence's hooks from PostHog's local settings, and the mod arm adds `--plugin-dir mods/coherence`. Both run this worktree's CLI through `COHERENCE_HOME`.

| | settings hooks | mod |
| --- | --- | --- |
| non-API time (`duration_ms − duration_api_ms`) | 8.98, 9.04, 8.63 s | 7.58, 7.53, 7.53 s |
| Bash PostToolUse (leaf entry), runHook's own | 3.27, 3.14, 3.12 s (plus about 0.25 s of process start) | 2.92, 2.89, 2.89 s (mod round trip 2.92, 2.89, 2.89 s) |
| Stop, runHook's own | 3.95, 3.84, 3.86 s | 3.54, 3.55, 3.51 s |
| UserPromptSubmit, Bash PreToolUse (mod round trip) | about 0.26 s each, from the protocol run | 13–15 ms, 8–13 ms |
| SessionStart | 0.26 to 0.5 s | 0.40–0.49 s, always through the CLI (see below) |

Each session spent about 1.1 to 1.5 s less outside the API with the mod. Settings arm 2 took one extra turn, which the model chose. The leaf-entry PostToolUse went over the 3 s tool-hook budget on every settings-hook run (3.1 to 3.3 s of work plus process start) and under it on every mod run (2.9 s round trip).

Not measured: an edit end to end (PostHog is read-only, u-e6e070fb), parallel tool calls (c-114af1cb), and a warm process dying mid-session in a real session (u-1ddc1a37; the plugin test and the socket test cover it). The six sessions had to carry Claude's UUID ids, not `spike-` ids (u-5a54ea2d):

- settings arm: 616c4b66-805f-4fd0-a8ff-11de943cf753, d1428946-0e4e-44d8-a19e-d56989d0f0a7, deeec6bd-4065-43af-9385-418391620416
- mod arm: f4a3dc38-b9cc-455a-a97c-49125418f95e, 65d9e184-c34c-4ebd-a345-b5b4caaa5fae, 1a015d39-2e62-4997-9354-1e9f3c4ee732 I tarred PostHog's four `.coherence` folders before the runs and restored them from the tar afterwards. `shasum` of every file, `git status`, `git diff` and the ignored listing all matched what they were before (d-48c56532).

## What worked

- **Forwarding the full answer.** `additionalContext` comes back as the classic result's `additionalContext`. A stop's `decision: block` comes back as `block`. A refusal (exit 2) comes back as `block`, or as `deny` at PreToolUse. Every part of an answer the agent reads could be forwarded.
- **Same output, same records.** The parity test compares stdout, stderr, exit code, the list of files under `.coherence` and the hook-time events for one session through both paths.
- **Coexistence.** The mod runs each event side by side with `next(e)`, so the project's other settings hooks still run and their results merge with Coherence's (d-c18c959d). It stands aside for any event whose settings hooks already run Coherence, so nothing runs twice.
- **The split between agent and user.** The agent gets context, blocks and refusals only. The user gets the stop's digest as `turn.complete` text under the answer, other `systemMessage`s and fallback notices as transcript lines and toasts, the edit verdict on the tool row, and the status line: `coherence 1.7.0 · hooks 2.9 s avg · warm 11 ms/event`, plus practices owed when there are any.
- **No silent skips.** A loss of the warm process is told to the user and the event runs through the CLI. A mod hook that fails reaches the agent as context through `.catch` ("Coherence's X hook did not answer at this event…"). A missing CLI tells the agent at SessionStart.
- **Never grants.** The mod returns no `allow` or `ask` and does not use `tool.check`. A Coherence refusal stands over whatever the hooks beneath decided.

## What the mods API could not do (2.1.295)

- **No streaming stdin to a child.** `$.process.spawn`'s `input` is written once and closed, so the stdin/stdout JSON-lines protocol the brief proposed cannot carry a second event. The transport is HTTP over a Unix socket via `$.http.fetch({ socketPath })` (d-5950a0ab).
- **No `systemMessage` in a classic result.** `ClassicResult` carries `block`, `additionalContext` and friends but no user-only message. The stop's digest moves to `turn.complete`, which fires after `classic.Stop` (d-ee012a98), and other events' messages move to `$.ui.log`.
- **`classic.PreToolUse` gets the tool call's envelope, not the settings hook's stdin.** The mod rebuilds `session_id`, `cwd`, `tool_name`, `tool_input` and `tool_use_id` from `$.session` and the envelope. `agent_type` comes from `$.agent.list()`, and `transcript_path` is absent.
- **`classic.SessionStart` fires before `session.start`.** In `claude -p` it fires about 0.5 s earlier, so the warm process can never answer the session's first event. It runs through the CLI, at the settings hook's cost (d-1b5c3a9f).
- **Helpers that take `$` must be top-level functions** (`claude plugin validate` refuses otherwise), so the mod keeps its session state in a module-level object.
- **Headless sessions draw nothing.** In `-p` and the SDK, `$.ui.status` and `$.ui.toast` are dropped ("no status row in a headless session"). `$.ui.log` reaches the debug log and the `ui_log` stream. In VS Code and Desktop the plugin test mounts the ToolUse row's tree, but I could not watch any surface myself (u-7b27ff5f).

## Surfaces

| what | terminal | Desktop | VS Code | `-p` / SDK |
| --- | --- | --- | --- | --- |
| status line (`$.ui.status`) | under the prompt | remote surface, up to 10,000 characters | remote surface | dropped |
| row verdict (`ui.render` ToolUse) | `⎿ coherence ✓ 2 invariants` / `✗ bypass: …` | drawn (plugin test) | drawn (plugin test) | none |
| stop digest (`turn.complete` text) | under the answer | under the answer | under the answer | not in the JSON result |
| fallback notice (`$.ui.toast` + `$.ui.log`) | toast and transcript line | both | both | the log line only, as `ui_log` |
| `/scope` (`immediate: true`) | opens the browser; transcript and Claude never see the token | same | same | not exercised |

## Recommendation

Ship it as an opt-in fast path for Claude Code (d-ee82802b). Codex keeps the settings hooks. Do not make it the default yet.

- **The gain is real.** The mod saves about 0.25 s of process start on every Coherence event, and about 1.1 to 1.5 s per short PostHog session. In the e2e runs that is what moved the leaf-entry hook from over the 3 s budget to under it.
- **The gain is bounded.** The expensive cases are work, not start-up: the first leaf entry (3 s) and the stop after an edit (19.5 s, c-ccb3a873). Those need their own fixes, and the warm process does not provide them.
- **Before a default:**
  1. Done: `hooks install --host claude --mod` installs the mod at the personal scope and removes the personal settings hooks; the committed ones stay and are named.
  2. Done differently: the repository is the mod's marketplace and the mod runs each project's own installed Coherence. A marketplace in the package's folder could not work, because Claude Code knows a marketplace by name machine-wide: a second project registering its own folder repointed the first project's mod, and removing it uninstalled the mod everywhere.
  3. Resolve c-5bebbd18 (caches in a long process) and c-114af1cb (serialised events).
  4. Watch the TUI on a real terminal and Desktop.

Records: decisions d-ee82802b (this recommendation), d-5950a0ab, d-c18c959d, d-a3c04486, d-1b5c3a9f, d-e93f6996, d-ee012a98, d-220b8b12, d-40c5664e, d-650d2276, d-47291537, d-48c56532; conjectures c-5bebbd18, c-114af1cb, c-ccb3a873, c-fbb29ddd; unable u-7b27ff5f, u-5a54ea2d, u-e6e070fb, u-1ddc1a37.
