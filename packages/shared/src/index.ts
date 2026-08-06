export * from "./events.js";
export * from "./summary.js";
export * from "./attribution.js";
export * from "./timeline.js";
export * from "./sessionState.js";
export * from "./codegraph.js";
export * from "./qa.js";
export * from "./blastRadius.js";

import type { ParentAttribution } from "./attribution.js";

/** A stored event as the sidecar hands it to the panel. */
export interface EventRow {
  id: number;
  session_id: string;
  seq: number;
  hook_event_name: string;
  tool_name: string | null;
  tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  prompt_id: string | null;
  received_at: string;
  summary: string;
  /**
   * The Agent call that spawned this event's subagent. Phase 0's equivalent of
   * Phase 1's `parentStepId` — there is no step concept yet, so the join key is
   * the parent's `tool_use_id`.
   */
  parent_tool_use_id: string | null;
  /** null for events outside a subagent; Phase 1 renders those as "root". */
  parent_attribution: ParentAttribution | null;
  /** The verbatim hook payload, parsed. */
  raw: unknown;
}

export interface SessionRow {
  session_id: string;
  cwd: string | null;
  transcript_path: string | null;
  source: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  event_count: number;
}

/**
 * Raw facts for a session-liveness decision, with the decision deliberately
 * left out. No event states that a session is over: `SessionEnd` is not
 * guaranteed to fire, and `Stop` marks the end of a turn, not a session. A
 * consumer combines `last_event_at_ms` with its own idle threshold.
 */
export interface SessionLiveness {
  session_id: string;
  cwd: string | null;
  started_at: string;
  last_event_at: string | null;
  last_event_at_ms: number | null;
  stop_received: number;
  session_end_received: number;
  explicit_end_received: number;
  last_end_kind: string | null;
  ended_at: string | null;
  end_reason: string | null;
  event_count: number;
}

export interface AttributionStats {
  session_id: string;
  total_subagent_events: number;
  unattributed_subagent_events: number;
  unattributed_pct: number;
}
