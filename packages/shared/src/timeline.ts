import { toolResponseOf } from "./events.js";
import type { ParentAttribution } from "./attribution.js";
import type { EventRow } from "./index.js";

/**
 * The join model: hook events + transcript position → an ordered, narrated
 * timeline.
 *
 * This module is pure. It runs identically in the sidecar and the panel, and
 * live rendering and replay both go through it — replay is the same view over
 * historical rows, fed once instead of over SSE, not a second code path.
 */

/** Where a step's `intent` came from. Both sources are verbatim transcript text. */
export type IntentSource = "text" | "thinking";

export type StepKind = "tool" | "subagent" | "task";
export type StepStatus = "pending" | "ok" | "error";

/** Extends Phase 0's two-value attribution with a root case for non-subagent steps. */
export type StepAttribution = ParentAttribution | "root";

export interface TimelineStep {
  id: string;
  sessionId: string;
  /** Phase 0 arrival order. Kept for audit and debugging; never sorted on. */
  seq: number;
  /** Transcript-derived sort key. This is what the UI orders by. */
  displayOrder: number;
  /**
   * True when no transcript record has been seen for this step yet, so
   * `displayOrder` is a provisional guess that parks it at the end. It moves to
   * its real position once the transcript catches up.
   */
  displayOrderProvisional: boolean;
  turnId: string;
  kind: StepKind;
  toolName?: string;
  /** Verbatim transcript text, or null. Never generated, never paraphrased. */
  intent: string | null;
  intentSource: IntentSource | null;
  target?: string;
  diff?: string;
  output?: string;
  durationMs?: number;
  agentId?: string;
  parentStepId?: string | null;
  parentAttribution: StepAttribution;
  status: StepStatus;

  /**
   * Narration for a delegating Agent call, shown on the group header rather
   * than per nested step.
   *
   * Subagent-internal steps never get an `intent`: their reasoning is not in
   * the parent transcript and sidechain transcripts are not ingested. Rather
   * than reconstruct something, a subagent group is narrated by the two facts
   * already present — what the parent asked for, and what came back.
   */
  delegationPrompt?: string;
  returnedSummary?: string;
}

export interface TurnGroup {
  turnId: string;
  sessionId: string;
  prompt: string | null;
  startedAt: string;
  /** Steps at the top level of this turn, in display order. */
  rootSteps: TimelineStep[];
  /** Subagent steps whose parent Phase 0 could not establish. Never merged above. */
  unattributedSteps: TimelineStep[];
  /** Subagent steps by parent step id, in display order. */
  childrenByParent: Map<string, TimelineStep[]>;
  stepCount: number;
  durationMs: number | null;
  /** True when no Stop has been seen — the turn is still running, or was cut off. */
  inProgress: boolean;
}

/** What the transcript tailer contributes for one tool call. */
export interface ToolIntent {
  tool_use_id: string;
  /** Line index of the tool_use record within the transcript. */
  transcript_pos: number;
  intent: string | null;
  intent_source: IntentSource | null;
}

/**
 * displayOrder packs two levels into one sortable integer: the transcript
 * position of a root step, and the arrival order of subagent steps nested
 * inside it.
 *
 * Subagent work has no transcript representation at all — `isSidechain` never
 * appears, and a subagent's internal tool calls exist only as hook events — so
 * there is no transcript position to sort them by. Anchoring them to their
 * parent's position and ordering by `seq` within it keeps transcript order
 * authoritative everywhere transcript data actually exists, and confines `seq`
 * to the one region where nothing else is available.
 */
const MAJOR = 1_000_000;

/**
 * Parking position for steps whose transcript record has not been read yet.
 *
 * It has to sort after every real transcript position, not before: a step of
 * unknown position belongs at the end until its true place is known, so that
 * backfilling moves it *earlier* into the narrative. Deriving this from the
 * highest position seen so far is wrong — early in a session that maximum is 0,
 * which would park unknown steps at the very top.
 */
const PROVISIONAL_POS = 1_000_000_000;

export function packOrder(transcriptPos: number, minor = 0): number {
  return transcriptPos * MAJOR + Math.min(minor, MAJOR - 1);
}

function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  // Tool results arrive as [{type:"text", text:"…"}] as often as plain strings.
  if (Array.isArray(value)) {
    const parts = value
      .map((v) =>
        typeof v === "string"
          ? v
          : typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).text === "string"
            ? ((v as Record<string, unknown>).text as string)
            : undefined,
      )
      .filter((v): v is string => v !== undefined);
    return parts.length > 0 ? parts.join("\n") : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function inputOf(event: EventRow): Record<string, unknown> {
  const raw = event.raw as Record<string, unknown> | null;
  const input = raw?.tool_input;
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function targetOf(toolName: string | undefined, input: Record<string, unknown>): string | undefined {
  const s = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  if (toolName === "Grep" || toolName === "Glob") return s(input.pattern) ?? s(input.path);
  return (
    s(input.file_path) ??
    s(input.path) ??
    s(input.notebook_path) ??
    s(input.command) ??
    s(input.url) ??
    s(input.pattern) ??
    s(input.description) ??
    s(input.prompt)
  );
}

/**
 * A minimal unified diff for Edit-shaped inputs.
 *
 * Deliberately not a real diff algorithm: Edit gives us the exact before and
 * after strings, so the changed region is already known and there is nothing to
 * infer. Write shows its content as an addition.
 */
export function diffOf(toolName: string | undefined, input: Record<string, unknown>): string | undefined {
  const oldStr = input.old_string;
  const newStr = input.new_string;
  if (typeof oldStr === "string" && typeof newStr === "string") {
    const removed = oldStr.split("\n").map((l) => `- ${l}`);
    const added = newStr.split("\n").map((l) => `+ ${l}`);
    return [...removed, ...added].join("\n");
  }
  if (toolName === "Write" && typeof input.content === "string") {
    return input.content
      .split("\n")
      .map((l) => `+ ${l}`)
      .join("\n");
  }
  return undefined;
}

interface PendingStep {
  pre: EventRow;
  post?: EventRow;
  failure?: EventRow;
  batchResult?: unknown;
}

/**
 * Assemble steps for one session.
 *
 * `events` may be in any order; `intents` may be incomplete, because the
 * transcript is written asynchronously and routinely trails the live session.
 * Neither is a reason to withhold a step — a step renders from its hook payload
 * immediately and gains its intent and true position later.
 */
export function buildTimeline(events: EventRow[], intents: ToolIntent[]): TurnGroup[] {
  const byArrival = [...events].sort((a, b) => a.seq - b.seq);
  const intentByToolUse = new Map(intents.map((i) => [i.tool_use_id, i]));

  // Pair Pre/Post by tool_use_id, and collect batch results as a fallback for
  // tool calls whose PostToolUse never arrived.
  const pending = new Map<string, PendingStep>();
  const batchResults = new Map<string, unknown>();

  for (const e of byArrival) {
    if (e.hook_event_name === "PostToolBatch") {
      const raw = e.raw as Record<string, unknown> | null;
      const calls = Array.isArray(raw?.tool_calls) ? raw.tool_calls : [];
      for (const call of calls) {
        const id = (call as Record<string, unknown>).tool_use_id;
        if (typeof id === "string") batchResults.set(id, toolResponseOf(call));
      }
      continue;
    }
    if (!e.tool_use_id) continue;
    const slot = pending.get(e.tool_use_id) ?? ({} as PendingStep);
    if (e.hook_event_name === "PreToolUse") slot.pre = e;
    else if (e.hook_event_name === "PostToolUse") slot.post = e;
    else if (e.hook_event_name === "PostToolUseFailure") slot.failure = e;
    if (slot.pre || slot.post || slot.failure) pending.set(e.tool_use_id, slot);
  }

  // Which Agent call each subagent belongs to, so nested steps can anchor to it.
  const agentParent = new Map<string, { toolUseId: string | null; attribution: ParentAttribution }>();
  // What each subagent reported back, keyed by the Agent call that spawned it.
  const summaryByParent = new Map<string, string>();

  for (const e of byArrival) {
    if (e.agent_id && !agentParent.has(e.agent_id)) {
      agentParent.set(e.agent_id, {
        toolUseId: e.parent_tool_use_id,
        attribution: e.parent_attribution ?? "unattributed",
      });
    }
    if (e.hook_event_name === "SubagentStop" && e.parent_tool_use_id) {
      const raw = e.raw as Record<string, unknown> | null;
      if (typeof raw?.last_assistant_message === "string") {
        summaryByParent.set(e.parent_tool_use_id, raw.last_assistant_message);
      }
    }
  }

  const steps: TimelineStep[] = [];
  let lastRootPos = 0;

  for (const [toolUseId, slot] of pending) {
    const anchor = slot.pre ?? slot.post ?? slot.failure;
    if (!anchor) continue;

    const resolution = slot.post ?? slot.failure;
    const input = inputOf(slot.pre ?? anchor);
    const toolName = anchor.tool_name ?? undefined;

    const agentId = anchor.agent_id ?? undefined;
    const parent = agentId ? agentParent.get(agentId) : undefined;

    let displayOrder: number;
    let provisional = false;

    if (agentId) {
      // DOCUMENTED DEVIATION from "transcript order wins".
      //
      // Subagent-internal steps order by `seq` within their group, not by
      // transcript position. This is not an oversight and not a bug: a
      // subagent's tool calls never appear in the parent transcript, and
      // sidechain transcripts are deliberately not ingested, so no transcript
      // position exists for these steps to sort by. `seq` is the only ordering
      // information there is inside a group.
      //
      // Transcript order still governs everything else, including where the
      // group as a whole sits: the group is anchored to its parent Agent call's
      // transcript position, so `seq` only ever orders steps relative to their
      // siblings inside one group. An unattributed agent has no parent to
      // anchor to, so it trails the last root step we placed — it renders in
      // its own group regardless.
      const parentIntent = parent?.toolUseId ? intentByToolUse.get(parent.toolUseId) : undefined;
      if (parentIntent) {
        displayOrder = packOrder(parentIntent.transcript_pos, anchor.seq);
      } else if (parent?.attribution === "unattributed") {
        displayOrder = packOrder(lastRootPos, anchor.seq);
      } else {
        displayOrder = packOrder(PROVISIONAL_POS, anchor.seq);
        provisional = true;
      }
    } else {
      const own = intentByToolUse.get(toolUseId);
      if (own) {
        displayOrder = packOrder(own.transcript_pos);
        lastRootPos = Math.max(lastRootPos, own.transcript_pos);
      } else {
        // Transcript has not caught up. Park it after everything with a known
        // position; it moves into place once the tailer reaches this record.
        displayOrder = packOrder(PROVISIONAL_POS, anchor.seq);
        provisional = true;
      }
    }

    const own = intentByToolUse.get(toolUseId);
    const output = resolution
      ? textOf(toolResponseOf(resolution.raw))
      : textOf(batchResults.get(toolUseId));

    const isDelegation = toolName === "Agent";
    const delegationPrompt = isDelegation
      ? ((typeof input.prompt === "string" ? input.prompt : undefined) ??
        (typeof input.description === "string" ? input.description : undefined))
      : undefined;
    // Prefer what SubagentStop reported; the Agent tool result carries the same
    // text, but only once the call has resolved.
    const returnedSummary = isDelegation
      ? (summaryByParent.get(toolUseId) ?? output)
      : undefined;

    steps.push({
      id: toolUseId,
      sessionId: anchor.session_id,
      seq: anchor.seq,
      displayOrder,
      displayOrderProvisional: provisional,
      turnId: "",
      kind: toolName === "Agent" ? "subagent" : "tool",
      toolName,
      // Subagent-internal steps have no transcript record and therefore can
      // never carry an intent. That is an absence, not a lookup failure.
      intent: own?.intent ?? null,
      intentSource: own?.intent_source ?? null,
      target: targetOf(toolName, input),
      diff: diffOf(toolName, input),
      output,
      durationMs:
        slot.pre && resolution
          ? Math.max(0, Date.parse(resolution.received_at) - Date.parse(slot.pre.received_at))
          : undefined,
      agentId,
      parentStepId: agentId ? (parent?.toolUseId ?? null) : undefined,
      parentAttribution: agentId ? (parent?.attribution ?? "unattributed") : "root",
      status: slot.failure ? "error" : resolution ? "ok" : "pending",
      delegationPrompt,
      returnedSummary,
    });
  }

  // Task events become their own steps, positioned by arrival within the turn.
  for (const e of byArrival) {
    if (e.hook_event_name !== "TaskCreated") continue;
    const raw = e.raw as Record<string, unknown> | null;
    steps.push({
      id: `task:${String(raw?.task_id ?? e.seq)}`,
      sessionId: e.session_id,
      seq: e.seq,
      displayOrder: packOrder(lastRootPos, e.seq),
      displayOrderProvisional: false,
      turnId: "",
      kind: "task",
      intent: null,
      intentSource: null,
      target: typeof raw?.title === "string" ? raw.title : undefined,
      parentAttribution: "root",
      status: "ok",
    });
  }

  return groupIntoTurns(byArrival, steps);
}

/**
 * Turns run UserPromptSubmit → Stop.
 *
 * Not SessionEnd: Phase 0 confirmed SessionEnd is not guaranteed to fire, while
 * Stop reliably closes each turn. A turn with no Stop is left open and marked
 * in progress rather than dropped — that is the killed-session case, and it is
 * a normal state to render, not an error.
 */
function groupIntoTurns(byArrival: EventRow[], steps: TimelineStep[]): TurnGroup[] {
  interface Bounds {
    turnId: string;
    prompt: string | null;
    startSeq: number;
    endSeq: number;
    startedAt: string;
    endedAt: string | null;
  }

  const bounds: Bounds[] = [];
  let index = 0;

  for (const e of byArrival) {
    if (e.hook_event_name === "UserPromptSubmit") {
      const raw = e.raw as Record<string, unknown> | null;
      bounds.push({
        turnId: `${e.session_id}:${index++}`,
        prompt: typeof raw?.prompt === "string" ? raw.prompt : null,
        startSeq: e.seq,
        endSeq: Number.POSITIVE_INFINITY,
        startedAt: e.received_at,
        endedAt: null,
      });
    } else if (e.hook_event_name === "Stop") {
      const open = bounds.at(-1);
      if (open && open.endSeq === Number.POSITIVE_INFINITY) {
        open.endSeq = e.seq;
        open.endedAt = e.received_at;
      }
    }
  }

  // A new prompt closes the previous turn even when no Stop was recorded.
  // Without this, a turn left open by a missing Stop swallows every later
  // turn's steps, because its bound extends to infinity.
  for (let i = 0; i < bounds.length - 1; i++) {
    bounds[i].endSeq = Math.min(bounds[i].endSeq, bounds[i + 1].startSeq - 1);
  }

  // Events before any UserPromptSubmit still belong somewhere — a session
  // resumed mid-turn, or the sidecar started late.
  if (bounds.length === 0 && steps.length > 0) {
    const first = byArrival[0];
    bounds.push({
      turnId: `${first.session_id}:0`,
      prompt: null,
      startSeq: 0,
      endSeq: Number.POSITIVE_INFINITY,
      startedAt: first.received_at,
      endedAt: null,
    });
  }

  const groups: TurnGroup[] = bounds.map((b, i) => ({
    turnId: b.turnId,
    sessionId: byArrival[0]?.session_id ?? "",
    prompt: b.prompt,
    startedAt: b.startedAt,
    rootSteps: [],
    unattributedSteps: [],
    childrenByParent: new Map<string, TimelineStep[]>(),
    stepCount: 0,
    durationMs: b.endedAt ? Date.parse(b.endedAt) - Date.parse(b.startedAt) : null,
    // Only the newest turn can still be running. An earlier turn with no Stop
    // simply never had one recorded — it is finished, not in flight.
    inProgress: b.endedAt === null && i === bounds.length - 1,
  }));

  const byOrder = [...steps].sort((a, b) => a.displayOrder - b.displayOrder || a.seq - b.seq);

  for (const step of byOrder) {
    const i = bounds.findIndex((b) => step.seq >= b.startSeq && step.seq <= b.endSeq);
    const group = groups[i === -1 ? groups.length - 1 : i];
    if (!group) continue;
    step.turnId = group.turnId;
    group.stepCount++;

    if (step.parentAttribution === "linked" && step.parentStepId) {
      const siblings = group.childrenByParent.get(step.parentStepId) ?? [];
      siblings.push(step);
      group.childrenByParent.set(step.parentStepId, siblings);
    } else if (step.parentAttribution === "unattributed") {
      group.unattributedSteps.push(step);
    } else {
      group.rootSteps.push(step);
    }
  }

  return groups;
}
