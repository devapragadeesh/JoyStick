# joystick

Renders a Claude Code session as a readable, teachable timeline in a local browser panel.

The plugin has no UI inside the Claude Code TUI. All UI is a local web app served by a sidecar
process on `127.0.0.1`. Claude Code talks to the sidecar through hooks.

**Status: Phase 2 complete** — event spine, narrated timeline, and a static import-graph map.

---

## Constraints this design is built around

| Constraint | How it is met |
| --- | --- |
| Zero Claude tokens in the hot path | No `prompt` or `agent` hooks anywhere. Every summary is a pure function of fields the payload already contains. |
| Never block the agent loop | Every hook is a `command` hook with `async: true`. Verified empirically — see [Verification 4](#4-does-it-cost-wall-clock-time). |
| Sidecar fails invisibly | The shim always exits 0. A refused connection costs the same as a successful one and produces no output. |
| Local only | Sidecar binds `127.0.0.1`. The shim passes `--noproxy '*'` so a configured `HTTP_PROXY` cannot route session contents off the machine. |
| Payloads are untrusted | Stored as text, never evaluated. Never shell-interpolated — the payload goes stdin → HTTP body without passing through a shell. Rendered only as React text children, never as HTML. |

---

## The one place the spec met reality

The original spec called for **HTTP hooks with `async: true`**. The live docs are explicit that these
are mutually exclusive:

> Only command hooks support `async` and `asyncRewake`. HTTP hooks and MCP tool hooks do not support these fields.

HTTP hooks also default to a **600-second** timeout, so a hung sidecar could have stalled the agent
loop for ten minutes.

Resolution: `command` hooks with `async: true` invoking `scripts/emit.sh`, a five-line POSIX shim
that pipes stdin into `curl`. This keeps both non-negotiables literally intact. The cost is one
`sh` + `curl` spawn per event, entirely off the critical path.

A second consequence: `${user_config.*}` is rejected in shell-form commands (substituting a
configured value into a shell command would let the shell run its contents). The port therefore
reaches the shim as `CLAUDE_PLUGIN_OPTION_PORT`, the documented alternative.

---

## Layout

```
.claude-plugin/plugin.json       manifest + userConfig.port
.claude-plugin/marketplace.json  local dev marketplace
hooks/hooks.json                 13 async command hooks
scripts/emit.sh                  the shim: stdin → POST → exit 0, always
scripts/replay.ts                feed a JSONL fixture into a running sidecar
scripts/bench.ts                 wall-clock A/B harness
packages/shared/                 zod schemas, summaries, subagent attribution
packages/sidecar/                Fastify + better-sqlite3 + SSE
packages/panel/                  React + Vite
fixtures/                        sample-session.jsonl, parallel-subagents.jsonl (real capture)
```

## Getting started

```bash
pnpm install
pnpm --filter @joystick/panel build     # panel is served by the sidecar from dist/
pnpm start                              # sidecar on http://127.0.0.1:8787

claude plugin marketplace add "$PWD"
claude plugin install joystick@joystick-dev --scope user --config port=8787
```

Develop with hot reload, without needing a live session:

```bash
pnpm dev                    # sidecar + Vite, panel on :5173 proxying to :8787
pnpm replay                 # replay fixtures/sample-session.jsonl
pnpm replay fixtures/parallel-subagents.jsonl --fresh --speed 4
```

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /events` | Ingest. Validates the envelope, writes, returns 204. Broadcast happens after the response. |
| `GET /health` | Liveness, port, db path, subscriber count. |
| `GET /stream` | SSE feed of new events. |
| `GET /api/events?limit&session_id` | Backfill, newest first. |
| `GET /api/sessions` | Known sessions with event counts. |

## Storage

SQLite under `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/joystick/joystick.db`), WAL mode.
Two tables, `sessions` and `events`, indexed on `(session_id, seq)`, `tool_use_id`, and `agent_id`.

Every event stores the **raw payload verbatim** alongside the extracted columns. Schemas use zod
`.passthrough()` and treat every field except `session_id` and `hook_event_name` as optional: an
event that fails the detailed schema is still stored, marked `known = 0`, rather than dropped. We
will want fields later that we have not thought of yet.

### `seq` is arrival order, not causal order

Hooks fire as independent async processes, so arrival order is not guaranteed to match what Claude
actually did. In practice it almost always does — but not always. From the parallel-subagent
capture:

```
34  SubagentStop   agent=133578
35  PostToolBatch  batch of 3: Agent, Agent, Agent   ← batch summary arrived first
36  PostToolUse    Agent  tuid=…ognJPR               ← before its own member's PostToolUse
```

`seq` is the authoritative append-log position and nothing more. Every correlation key
(`tool_use_id`, `agent_id`, `prompt_id`) is preserved so Phase 1 can reconstruct true causal order
from the transcript.

### Subagent attribution is inferred, not given

Claude Code does not state which `Agent` tool call spawned which subagent. `SubagentStart` carries
`agent_id` but no `tool_use_id`; the `Agent` `PreToolUse` carries `tool_use_id` but no `agent_id`.

`linkSubagents()` in `packages/shared/src/attribution.ts` pairs them by spawn adjacency, FIFO. This
was validated against three subagents launched in a single parallel batch, and cross-checked against
an independent derivation from the stop side — both produce the same pairing. It is still inference
over an undocumented ordering guarantee, so it lives in one function, runs after the fact, never
affects what gets stored, and yields `null` rather than a guess when it cannot determine a parent.

---

## Phase 0 verification

Run against Claude Code 2.1.220, Node 25.8.1, macOS (darwin 25.5.0).

### 1. Real multi-step session

A scratch repo, one session: read two files, edit both, run a command, spawn an `Explore` subagent.
29 events captured, correctly ordered, every Pre/Post pair matching on `tool_use_id`:

```
seq  event             tool   agent    summary
1    SessionStart      -      -        session started (startup)
2    UserPromptSubmit  -      -        Do all of these steps: 1) Read src/greet.js …
3    PreToolUse        Read   -        Read src/greet.js
4    PostToolUse       Read   -        Read src/greet.js
…
16   PreToolUse        Agent  -        Agent Search the repo at /private/tmp/joystick-scratch
17   SubagentStart     -      Explore  subagent started: Explore
18   PreToolUse        Bash   Explore  Bash ls -la && git log --oneline -5
…
26   SubagentStop      -      Explore  subagent finished: Explore
27   PostToolUse       Agent  -        Agent Search the repo at /private/tmp/joystick-scratch
29   Stop              -      -        All five steps done: 1. **Read** `src/greet.js` …
```

**Pass.** Event count and ordering match what the session actually did.

### 2. Ordering under parallelism

A second session spawning **three** `Explore` subagents in one parallel batch — 38 events. The three
agents' tool calls interleave heavily (seq 9–29) but `agent_id` separates them cleanly. This capture
is committed as `fixtures/parallel-subagents.jsonl` and the attribution tests run against it.

**Pass**, with the two caveats documented above: one ordering inversion at seq 35, and parent
attribution being inferred rather than given.

### 3. Killing the sidecar mid-session

Sidecar killed 12 seconds into a 23-second session and left dead for the remainder.

- Session exited **0**. No errors, no warnings, no visible latency.
- Events truncated cleanly at seq 14 — everything before the kill persisted, nothing after.
- `PRAGMA integrity_check` → `ok` after the abrupt termination.
- After restart, the same session's `seq` continued **14 → 15**. The counter is durable.

Measured directly: a hook call costs **17ms with the sidecar up and 17ms with it down** —
connection-refused on loopback returns immediately, so a dead sidecar never hangs the shim.

**Pass.**

### 4. Does it cost wall-clock time?

The A/B in the task spec — same scripted task, 3 runs with hooks, 3 without — **cannot answer this
question**, and reporting its number as a result would be misleading. Both attempts:

| Runs per arm | mean delta | median delta | ranges |
| --- | --- | --- | --- |
| 3 | +3.37% | −2.81% | overlap |
| 8 | −22.97% | −7.04% | overlap |

At 8 runs the hooks-enabled arm measured 23% **faster**, which is obviously not a real effect. An
agent run is 6–23 seconds and dominated by model latency; the arms' ranges overlap almost entirely.
This harness is resolving noise, not hook cost.

So the question was settled a different way. `scripts/emit.sh` was temporarily patched to
`sleep 3` before doing anything, injecting a deliberate 3-second delay into every hook:

```
wall clock:     15311ms
events fired:   17
if hooks were synchronous this would have cost an extra 51s
```

**51 seconds of hook work; the session finished in 15.3 seconds**, inside the normal range for that
task. `async: true` genuinely detaches hooks from the agent loop.

**Pass.** Wall-clock impact is structurally zero rather than merely small — Claude Code spawns the
hook and does not wait. The relevant budget is the 17ms of *background* work per event, well inside
the ~50ms target.

> The A/B harness is kept as `pnpm bench` because it is the right shape for catching a future
> regression that *does* block. Its output now reports median alongside mean and flags overlapping
> ranges, so it cannot be misread as precise.

### 5. Subagent attribution

`agent_id` and `agent_type` are present on every subagent-internal event — `SubagentStart`,
`SubagentStop`, and all nested `PreToolUse` / `PostToolUse` / `PostToolBatch` events. Across three
concurrent subagents each was attributed to the correct parent `Agent` call, confirmed by two
independent derivations.

**Pass**, with the caveat that the parent link is inferred. See above.

---

## Phase 0 closeout

Three changes folded in after review, plus one correction the review surfaced.

### The docs are wrong about where tool results live

Preparing the "`PostToolBatch` uses `output`" type, the real captures disagreed with the docs
for **both** result-bearing events:

| event | docs say | Claude Code 2.1.220 sends |
| --- | --- | --- |
| `PostToolUse` | `tool_result` | **`tool_response`** — 51/51 payloads |
| `PostToolBatch` | `output` | **`tool_response`** — 51/51 `tool_calls` entries |

Neither documented name appeared even once. The useful consequence is the inverse of the
review's premise: the two events are **not** inconsistent with each other — they agree, and
the docs are wrong about both. Transcript-join code can read one field for both.

`RESULT_FIELD_NAMES` and `toolResponseOf()` in `packages/shared/src/events.ts` resolve
whichever name is present, observed-first. All three parse, so a version that emits a
documented name still works. `resultField.typecheck.ts` is a compile-time guard.

This was latent rather than harmful in Phase 0 — the raw payload is stored verbatim and the
summariser only reads `tool_name` — but it would have silently broken Phase 1's join.

### Attribution and liveness are now queryable

`events` gained `parent_tool_use_id` and `parent_attribution` (`"linked"` / `"unattributed"`),
resolved **at write time**. Resolution reads pending spawns from SQLite rather than memory, so
a sidecar restart mid-session does not orphan agents that were correctly linkable. Events
outside a subagent get `NULL` — Phase 0 does not invent Phase 1's `"root"`.

`sessions` gained `last_event_at`, `last_event_at_ms`, `stop_received`, `session_end_received`,
and `last_end_kind`. `Stop` is stored separately from `SessionEnd` because it ends a *turn*,
not a session.

Two views, plus `/api/attribution` and `/api/liveness`:

```sql
SELECT * FROM session_subagent_attribution;  -- total / unattributed / pct, per session
SELECT * FROM session_liveness;              -- last_event_at, explicit_end_received, …
```

Neither computes an "ended" verdict. That needs an idle threshold and belongs to the panel.

### Closeout verification

**1. Real capture stays fully linked.** ✅ Replaying the three-subagent capture:

```
session_id                            total  unattributed  pct
6bf72ce5-9bbc-412d-b4a9-46406ec19a1f  27     0             0.0
unattributed-0001                     5      5             100.0

agent   attribution   parent  events
133578  linked        ognJPR  10
95511c  linked        Sjshjg  12
b267c9  linked        uTpZsE  5
orphan  unattributed  —       5
```

Parent links match the Phase 0 ground truth exactly. **Observed unattributed rate on real
data: 0%** — evidence the FIFO-adjacency assumption holds.

**2. Forced null branch.** ✅ `fixtures/unattributed-subagent.jsonl` has a `SubagentStart` with
no spawning `Agent` call, preceded by an unrelated `Read`. All five subagent events come back
`unattributed` with a null parent — the `Read`'s `tool_use_id` is never borrowed:

```
seq  event             tool  attribution   parent
3    PreToolUse        Read  (none: root)  (null)
5    SubagentStart     -     unattributed  (null)
6    PreToolUse        Glob  unattributed  (null)
9    SubagentStop      -     unattributed  (null)
```

**3. Type-level guard.** ✅ Renaming `tool_response` → `tool_result` fails the build in both
directions:

```
error TS2339: Property 'tool_response' does not exist on type 'BatchToolCall'.
error TS2578: Unused '@ts-expect-error' directive.
```

The second is the important one: it means deleting a guard line cannot silently pass.

**4. Truncated session.** ✅ Sidecar killed 11s in; session exited 0. Facts captured:

```
        last_event_at = 2026-08-06T08:56:46.320Z
        stop_received = 0
 session_end_received = 0
explicit_end_received = 0
        last_end_kind =
          event_count = 17
```

`last_event_at` populated, `explicit_end_received` false, no verdict computed.

### Tests

40 tests, all passing. The attribution suites run against the real parallel-subagent capture
rather than a synthetic fixture — synthetic data would not have exercised the interleaving.

```
✓ packages/shared/src/summary.test.ts      (8)
✓ packages/shared/src/attribution.test.ts  (7)
✓ packages/sidecar/src/server.test.ts     (10)
✓ packages/sidecar/src/closeout.test.ts   (15)
```

---

---

## Phase 1 — narrated timeline

Three spec premises did not survive contact with real transcripts. All were confirmed
against a 1.8 MB interactive session (180 tool calls) as well as the `-p` captures.

### What the transcript actually looks like

**`text` and `tool_use` never share a message.** 0 of 180. Claude Code writes every content
block as its own record; assistant shapes are only ever `tool_use` (180), `text` (67), or
`thinking` (54). So "the text immediately preceding the tool call" cannot mean the preceding
*block* — it means the preceding assistant *record*, reached through `parentUuid`. That is
what `resolveIntent` walks.

**Intent coverage is structural, and thinner than the spec assumes.** Only the first tool
call of a run tends to follow prose; later ones follow a `tool_result` record and have no
preceding reasoning at all. Measure it with `pnpm coverage <transcript|dir>`, which runs the
product's own extraction path rather than a reimplementation.

**`thinking` blocks are persisted without their text.** Every one carries a `signature` and
an empty `thinking` string: **0 of 2944** thinking blocks across every project on the
development machine had usable content. An earlier revision of this document reported 44%
coverage by counting thinking blocks as available reasoning — that was wrong, and the real
figure is the text-only column. The code was always correct (an empty string is falsy, so it
yields `null`), and `intentSource: "thinking"` remains wired up in case the format changes,
but it fires 0% of the time today.

| session | tool calls | text | thinking | usable |
| --- | --- | --- | --- | --- |
| real interactive | 263 | 37% | 0% | **37%** |
| `-p` runs, aggregate | 76 | 42% | 0% | 42% |
| prompted to narrate each step | 6 | 83% | 0% | 83% |

**Subagent work has no transcript representation.** `isSidechain: true` appears 0 times. A
transcript contains the `Agent` tool_use but none of the subagent's internal calls, which
exist only as hook events. Two consequences: subagent steps can never carry an intent, and
they have no transcript position to sort by. `displayOrder` therefore packs two levels into
one integer — `transcriptPos * 1e6 + seq` — anchoring nested steps to their parent's
position and using `seq` only inside the one region where no transcript data can exist.

Rather than reconstruct a subagent's reasoning, a group is narrated by two facts already in
the data: the delegating call's prompt and the subagent's `last_assistant_message`, shown as
**asked** / **returned** on the group header. Nested steps keep `intent: null` and the
ordinary marker — no special case, nothing invented. Ingesting sidechain transcripts is a
Phase 2+ candidate, not built.

### Intent coverage experiment

A `CLAUDE.md` house-style convention asking for a one-line reason before non-trivial tool
calls, tested on matched tasks across two multi-turn sessions and one single-shot `-p` run
per arm, in two identical scratch repos differing only by that file:

| arm | tool calls | coverage |
| --- | --- | --- |
| baseline, no convention | 12 | **17%** |
| with the convention | 11 | **45%** |

A real move — 2.6× — and consistent across all three session pairs (20→50, 25→50, 0→33).
Task quality was unaffected: both arms produced correct, equivalent JSDoc and clean syntax
checks, with near-identical tool counts, so the convention is not buying coverage with
busywork.

It still falls well short of the ~65–70% bar set for adopting it as a default, so **Phase 2
should be designed for a timeline where most steps have no stated reasoning**. The
convention is worth documenting as opt-in for people who want denser narration; it is not
worth shipping as a default on a 45% return. One attempt, no wording iteration.

The interactive baseline of 37% was not re-measured under the convention — new interactive
sessions cannot be driven programmatically. The controlled comparison above is within-mode.

### Architecture

`buildTimeline()` in `packages/shared` is pure and runs in both the sidecar and the panel.
Live rendering and replay call it identically — replay is the same view over historical rows,
fed once instead of over SSE, which makes parity a property of the design rather than
something to hope for.

The tailer reads each transcript from a persisted byte offset, never re-reading from the
start. A partial trailing line is left unconsumed until the next poll, and a file that shrank
resets to zero. Steps render from their hook payload immediately and gain intent and true
position whenever the transcript catches up; until then `displayOrderProvisional` parks them
at the end.

### Phase 1 verification

**1. Ordering correctness.** ✅ The parallel-subagent capture, with its documented `seq`
inversion, renders in transcript order:

```
    seq   displayOrder   tPos  tool   target
      3        7000000      7  Agent  Find all JS files
      5        8000000      8  Agent  Summarize package.json
      7        9000000      9  Agent  List git history

  arrival sequence around the inversion:
    … 33:PostToolUse  35:PostToolBatch  36:PostToolUse
```

`seq` 35 (the batch summary) arrives before `seq` 36 (its own member's result); display order
is unaffected because it derives from transcript position.

**2. Intent integrity.** ✅ Automated, in `timeline.test.ts`: every non-null `intent` for a
captured session must appear verbatim as a substring of that session's transcript file,
compared in JSON-encoded form so no unescaping or reformatting can slip through.

**3. Null-intent handling.** ✅ Real null steps occur in every capture (10 of 11 in the
subagent session; 1 of 6 in the prompted one). *(Superseded by the panel simplification
below: `intent` is no longer the default view's basis, so a null one no longer needs a
placeholder — see "Default view no longer depends on intent".)*

**4. Unattributed subagent steps.** ✅ Rendered in a dashed amber group headed "unattributed
subagent steps · parent could not be determined", inside their turn but never merged into the
root list. Tests assert they are neither dropped from the step count nor given a guessed
parent.

**5. Transcript lag / late insertion.** ✅ Demonstrated live with `JOYSTICK_NO_TAIL=1`:

```
BEFORE (transcript unread)          AFTER (tailer caught up)
displayOrder=1000000000000003       displayOrder=7000000   intent="I'll spawn all three…"
displayOrder=1000000000000005       displayOrder=8000000   intent=null
displayOrder=1000000000000007       displayOrder=9000000   intent=null
provisional=true                    provisional=false
```

Steps park at the end while their position is unknown and move *earlier* on backfill. An
early version parked them at position 1 instead, so backfilling pushed them later — caught by
the verification test, not by inspection.

**6. Turn grouping.** ✅ Bounded by `UserPromptSubmit` → `Stop`. A killed session's
unterminated turn renders as in progress with its unresolved call marked in flight, rather
than erroring. **The panel caught a bug the tests missed**: with no `Stop` between turns, an
open turn's bound ran to infinity and swallowed every later turn's steps. A new prompt now
closes the previous turn, and only the newest turn can be in progress. Regression test added.

**7. Session state badges.** ✅ One real session per state, no mocked data — the "Likely
ended" case is the genuinely killed session from Phase 0 closeout:

```
  live-now     end=0  idle=      1s  thr=300s  -> live
  fixture-00   end=1  idle=      1s  thr=300s  -> ended
  a87fa6f6-7   end=0  idle=   7381s  thr=300s  -> likely-ended
```

Green solid, grey, and amber dashed respectively.

**8. Replay parity.** ✅ Snapshotted the rendered DOM of a live session, did a full page
reload, re-selected, and re-snapshotted: **byte-identical, 2052 chars both**.

**9. `toolResponseOf()` coverage.** ✅ Every `PostToolUse` and every `PostToolBatch`
`tool_calls` entry in a real capture resolves to a defined value, and all 11 resolved steps
carry non-empty output. This is the standing regression test for the field-name bug.

### Tests

75 tests. The intent-integrity, ordering, and coverage suites run against real captures.

```
✓ packages/shared/src/summary.test.ts      (8)
✓ packages/shared/src/attribution.test.ts  (7)
✓ packages/sidecar/src/server.test.ts     (10)
✓ packages/sidecar/src/closeout.test.ts   (15)
✓ packages/sidecar/src/timeline.test.ts   (25)
✓ packages/sidecar/src/regression.test.ts (10)
```

`regression.test.ts` covers the two bugs that verification caught and review did not. Both
existed because every fixture at the time was well-formed, so each has a fixture shaped to
reproduce the exact condition that let it hide:

- `late-backfill.jsonl` — a step whose transcript position arrives after a provisional one
  was already assigned, positioned in the **middle** of a run with known positions on both
  sides. The original bug parked provisional steps at the lowest slot rather than the
  highest; a fixture where the provisional value happened to be lowest would have passed.
- `unbounded-turn.jsonl` — a turn that never receives a `Stop`, sitting in the **middle** of
  a three-turn session. The Phase 0 kill case missed this because there the unterminated
  turn was last, where an unbounded end is harmless.

---

## Panel simplification: default view no longer depends on intent

Phase 1's default view leaned on `intent` — present on only ~37% of real steps — so 63% of
steps rendered as a bare tool call with nothing readable, next to a minority that showed a
full sentence and inconsistent density. Fixed at the rendering layer only: no change to
`TimelineStep`, the join model, `displayOrder`, `toolResponseOf()`, subagent grouping, turn
grouping, or session state.

**Every step now shows exactly one deterministic line by default**, from `summarizeStep()`
in `packages/panel/src/summarize.ts` — a pure, total function keyed only on `kind`/
`toolName`/`target`/`status`. It never reads `step.intent`; a test proves this by making
`intent` throw on access and asserting `summarizeStep` still succeeds, and a second test
asserts two steps identical except for `intent` produce an identical line. Diffs, output,
the full untruncated command/path, and `intent` (when present, labeled "Claude's reasoning")
all move behind one expand control per step — `intent` is additive detail at that point,
same tier as the diff, never a fallback anyone reads from.

The former "no stated reasoning" placeholder is removed outright, not just hidden: the null
case needed a placeholder only because Phase 1's default view had nothing else to show when
`intent` was absent. Now the default view always has the one-liner, so there is nothing to
mark as absent.

**Judgment calls:**
- Error auto-expand — already existed from Phase 1 (`useState(isError)`), just re-verified
  it still holds after the rewrite. No new work; noting it since the brief asked for it.
- Added a "target"/"command" line inside the expanded detail so the full path or command is
  still reachable once removed from the collapsed row — Bash commands past 50 characters
  would otherwise be unrecoverable. Not explicitly requested; flagged here rather than done
  silently.
- `ExploredSummary`'s group header (multiple folded Read/Grep/Glob calls) was reworded to
  the same "Looked through N files" phrasing as the single-step case, since it is that same
  line standing in for several calls at once, not a separate concept.
- Verification 2 ("component test... render an identical default view") is implemented as a
  `summarizeStep`-level equivalence test rather than a rendered-DOM snapshot: the repo has no
  jsdom or testing-library today, and `summarizeStep` never reading `intent` is the thing
  that *makes* the rendered output identical, so proving it at the function level is a direct
  proof of the same property, not a weaker substitute for it.

89 tests total (was 75); all Phase 1 suites pass unmodified.

```
✓ packages/panel/src/summarize.test.ts     (14)
```

---

## Phase 2 — static architecture map

A second panel tab: an interactive map of file-level import relationships, built on graphify's
code-only extraction — evaluated in a prior time-boxed spike (not committed to this repo; findings
summarized inline below wherever they shaped a decision). No live coupling to edits in this phase
— the graph refreshes on a debounce, but nothing animates in the open panel yet.

### Housekeeping, first

The spike found joystick's own plugin failing to load: `plugin.json` declared
`"hooks": "./hooks/hooks.json"`, which is also auto-loaded by convention, so every event fired
twice. Fixed and committed alone, before any Phase 2 code: removed the redundant declaration,
verified a real session now fires each event exactly once.

### What changed, and why

**graphify is invoked only by joystick — never the reverse.** `packages/sidecar/graphify.ts`
shells out to `graphify extract . --code-only` as an async subprocess, triggered only from
`packages/sidecar/codegraph-triggers.ts`: once on `SessionStart` if no graph is cached, and
debounced (2.5s of inactivity) on `PostToolUse` for `Edit`/`Write`/`NotebookEdit`. graphify's own
`claude install` hook is never installed — the spike found it synchronous and directive-injecting,
which is incompatible with every constraint this project has held since Phase 0.

**`INFERRED` edges are filtered at the parse boundary, not the UI.** `mapGraphifyOutput()` in
`packages/shared/codegraph.ts` drops every non-`EXTRACTED` edge before a `CodeEdge` is ever
constructed. `CodeEdge` itself has no field that could hold a confidence tag — there is nowhere
for an `INFERRED` edge to be stored even by mistake. Verified live: the raw extraction of
joystick's own repo contains 5 `INFERRED` edges (`dropped_inferred_count: 5` in the stored meta);
zero appear in `/api/codegraph`'s edges, and the SQLite schema for `code_edges` has no confidence
column at all.

**graphify's shape is validated, not trusted.** `GraphifyOutputSchema` (zod) checks the real
`{nodes, links}` shape at the parse boundary. A malformed or unexpected payload — verified live by
feeding the sidecar an actual `graph.json` mutated into the README-implied `{nodes, edges}`
shape — logs `graphify output rejected, keeping previous graph: ...` and leaves the previously
cached graph completely untouched, rather than crashing the sidecar or replacing a working graph
with an empty one.

**File identity assumption from the spike was wrong on inspection.** The spike's mapping script
assumed a file-level node's `id` equals its `source_file` string. Building the real mapper and
checking a multi-symbol file (`App.tsx`) directly: the file-level node's `id` is a slugified path
(`packages_panel_src_app`), not the literal source path. Every node still carries a correct
`source_file` field, though, so `CodeNode`s are now derived from the set of distinct `source_file`
values across *all* nodes — sidestepping the ambiguity about which node "is" the file, rather than
trying to identify it.

**`graphify update` is rejected, benchmarked on joystick's own repo, not assumed.** A single
one-line comment addition — which changes zero AST nodes — was fed through both paths on the
identical edited tree:

| path | nodes | edges | wall clock |
| --- | --- | --- | --- |
| fresh full `extract` (ground truth) | 414 (unchanged) | 624 (unchanged) | ~1.0–1.2s |
| `graphify update` | 450 (+36) | 653 (+29) | ~1.0–1.2s |

No time savings, and a measurably wrong graph. Every trigger — cold start and debounced
re-extraction alike — runs a full extract. This is also the number that answers whether Phase 3's
live coupling is feasible on top of this: **~1.0–1.2s per full reindex on joystick's own ~51-file
repo.**

**Storage: SQLite, not a flat JSON file.** Three new tables (`code_graph_meta`, `code_nodes`,
`code_edges`) under the same database as everything else, replaced transactionally on every
extraction. Chosen over a JSON file so the graph is queryable the same way as the rest of the
sidecar — indexed neighbor lookups for the click-to-highlight interaction, and a natural home for
Phase 3's reverse-dependency queries — rather than fragmenting storage across two formats.
Per-file SHA-256 content hashes are computed by joystick itself, since graphify's own output
carries none.

### Rendering

Cytoscape.js, `cose` force-directed layout (built into cytoscape core — no extra dependency
needed). Two-level model, no compound nesting: a directory is either one collapsed aggregate node
or fully expanded to its individual files, never both — `packages/panel/codeMapLayout.ts` is a
pure, DOM-free function that resolves every edge endpoint to whichever id is currently visible, so
an edge from an expanded file to a still-collapsed directory correctly points at the aggregate.
Clicking a file highlights its direct neighbors and fades everything else; clicking a directory
expands it. Labeled "Import graph" throughout, deliberately, with an inline "extracted imports
only · no call graph" caption — Phase 2 ships file-level `EXTRACTED` import edges and nothing
else, and the UI says so rather than implying more.

### Phase 2 verification

**1. Hook double-fire fix.** ✅ Removed the redundant `plugin.json` declaration; a real session
against a scratch repo shows every event exactly once (`SessionStart` → `UserPromptSubmit` →
`PreToolUse` → `PostToolUse` → `PostToolBatch` → `Stop`, no duplicates).

**2. No API key / nothing leaves the machine.** ✅ Re-confirmed directly in this session, not
inherited from the spike: every provider credential env var unset, extraction succeeds, and
`lsof -i` polled through the entire run shows zero network connections.

**3. Accuracy spot-check.** ✅ 10/10 — this time pulled from the running sidecar's actual
`/api/codegraph`, not the spike's scratch script, and manually verified against real source. One
(`db.ts → codegraph.ts`) required tracing through the `@joystick/shared` barrel re-export to
confirm — correct, but not a direct same-file import, which is itself informative about how
graphify resolves package-boundary imports.

**4. Schema validation works.** ✅ Fed the sidecar a real `graph.json` mutated into
`{nodes, edges}` (the README-implied, wrong shape). Result: `graphify output rejected, keeping
previous graph: ...` logged, sidecar's `/health` unaffected before and after, and — tested as two
separate cases — both "no graph existed yet" (stays `null`) and "a good graph already existed"
(stays byte-identical, confirmed by matching `extracted_at`) survive a subsequent bad extraction
untouched.

**5. `INFERRED` edges never reach the graph.** ✅ Confirmed three ways: `dropped_inferred_count:
5` in the stored meta (proving they were seen and counted, not silently absent from the source
data), every stored edge's `source` field is `graphify-extracted` with no other value present, and
`CodeEdge`/the `code_edges` SQL schema have no field capable of holding a confidence tag at all —
structurally, not just behaviorally, impossible.

**6. Async, non-blocking trigger.** ✅ Phase-0-style sleep injection: `GRAPHIFY_BIN` pointed at a
stub that sleeps 5 seconds before writing valid output. `SessionStart` (which triggers the
extraction) still responded in **21ms**, and 20 further unrelated events fired *during* the 5s
window totaled **234ms** (~11ms each) — versus the >5000ms either would have taken if the
subprocess were blocking. The extraction completed and populated the graph after the sleep
elapsed, confirming the slow path isn't silently dropped, just never waited on.

**7. Incremental benchmark result.** ✅ See above: `update` rejected (wrong graph, no time
savings); full extract chosen for every trigger, ~1.0–1.2s on joystick's own repo.

**8. Rendering at real scale.** ✅ Screenshotted against joystick's own live repo (52 files, 97
import edges after dedup): default collapsed-by-directory view (6 directory nodes, correctly
weighted edges) and an expanded `packages/panel/src` (12 files, real edges to still-collapsed
directories, breadcrumb chips to re-collapse). A real bug surfaced taking these screenshots — see
below.

**9. Neighbor highlighting.** ✅ Screenshotted: clicking `App.tsx` highlights its five direct
neighbors (`Timeline.tsx`, `useSession.ts`, `SessionPicker.tsx`, `CodeMap.tsx`, `main.tsx`) in
green; every other node and edge fades to ~12% opacity.

### A UX bug found while taking the verification screenshots, not by a test

`useCodeGraph`'s poll (every 4s, since the graph updates asynchronously in the background with
nothing to push a change notification) called `setGraph` with a fresh object on every tick even
when the underlying data hadn't changed. A fresh object reference re-triggered the `cose` layout
on an unrelated timer, visibly shuffling every node's position out from under the cursor — which
is exactly why the first highlight-interaction screenshot attempt missed its target. Fixed by
skipping `setGraph` when the polled `extracted_at` matches what's already held.

### Tests

130 tests (was 89). `packages/shared/codegraph.test.ts` and `packages/panel/codeMapLayout.test.ts`
run against a real captured `graph.json` from joystick's own repo (`fixtures/graphify-graph.json`),
not synthetic data, for the same reason every prior real-capture fixture exists — synthetic data
would not have caught the file-identity assumption being wrong.

```
✓ packages/shared/src/codegraph.test.ts     (12)
✓ packages/panel/src/codeMapLayout.test.ts  (16)
✓ packages/sidecar/src/codegraph.test.ts    (13)
```

## Known gaps

- **`SessionEnd` is not guaranteed.** It fired in some `claude -p` runs and not others. `SessionEnd`
  hooks share a 1.5-second budget, so the panel must treat an unterminated session as normal.
- **Parent attribution is inference.** If Claude Code ever changes the ordering of `SubagentStart`
  relative to the spawning `Agent` call, `linkSubagents()` breaks. It is isolated and tested against
  a real capture for exactly this reason.
- **Tool results live in `tool_response`, which no documentation mentions.** Read them through
  `toolResponseOf()`, never by reaching for a field name directly.
- **Events arriving before their session's `SessionStart`** are handled by upserting a session row
  from whatever event arrives first, since the sidecar may start mid-session.
- **Most steps have no stated reasoning.** Around 56% of steps in a normal interactive session,
  more in `-p` runs. This is a property of how transcripts are written, not of the extractor.
  Prompting Claude to explain each step raises it to ~83%.
- **Subagent steps can never have an intent**, since subagent work never reaches the transcript.
