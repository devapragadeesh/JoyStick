# joystick

Renders a Claude Code session as a readable, teachable timeline in a local browser panel.

The plugin has no UI inside the Claude Code TUI. All UI is a local web app served by a sidecar
process on `127.0.0.1`. Claude Code talks to the sidecar through hooks.

**Status: Phase 0 complete** — the event spine. Phase 1 (narrated timeline) has not started.

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

### Tests

25 tests, all passing. The attribution suite runs against the real parallel-subagent capture rather
than a synthetic fixture — synthetic data would not have exercised the interleaving.

```
✓ packages/shared/src/summary.test.ts      (8)
✓ packages/shared/src/attribution.test.ts  (7)
✓ packages/sidecar/src/server.test.ts     (10)
```

---

## Known gaps

- **`SessionEnd` is not guaranteed.** It fired in some `claude -p` runs and not others. `SessionEnd`
  hooks share a 1.5-second budget, so the panel must treat an unterminated session as normal.
- **Parent attribution is inference.** If Claude Code ever changes the ordering of `SubagentStart`
  relative to the spawning `Agent` call, `linkSubagents()` breaks. It is isolated and tested against
  a real capture for exactly this reason.
- **`PostToolBatch` names its result field `output`**, not `tool_result` as every other tool event
  does. Handled, but easy to trip over.
- **Events arriving before their session's `SessionStart`** are handled by upserting a session row
  from whatever event arrives first, since the sidecar may start mid-session.
