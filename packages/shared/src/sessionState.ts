/**
 * Session state is computed, never observed.
 *
 * No event says a session is over. `SessionEnd` is not guaranteed to fire —
 * Phase 0 saw it absent from several real runs — and `Stop` ends a turn, not a
 * session. So a session that crashed and one that exited cleanly are
 * indistinguishable from the event log alone, and the difference has to come
 * from an idle threshold applied to `last_event_at`.
 *
 * Keeping this a pure function of already-captured facts means the picker never
 * waits on an event that may never arrive.
 */

export type SessionState = "ended" | "likely-ended" | "live";

export interface SessionSummary {
  session_id: string;
  cwd: string | null;
  title: string | null;
  started_at: string;
  last_event_at: string | null;
  last_event_at_ms: number | null;
  explicit_end_received: number;
  event_count: number;
  files_touched: number;
  /** Median gap between this session's own events, in ms. */
  median_gap_ms: number;
}

/** Floor for the idle window: below this, ordinary thinking time reads as death. */
export const MIN_IDLE_MS = 5 * 60 * 1000;

/**
 * A session is "likely ended" once it has been quiet for longer than both five
 * minutes and twice its own median inter-event gap. The second term adapts to
 * pace: a session that fires an event every 200ms is meaningfully idle far
 * sooner than one that pauses for minutes between tool calls, but the floor
 * stops a fast session from being declared dead during a single long tool call.
 */
export function idleThresholdMs(medianGapMs: number): number {
  return Math.max(MIN_IDLE_MS, 2 * medianGapMs);
}

export function sessionState(summary: SessionSummary, now: number = Date.now()): SessionState {
  if (summary.explicit_end_received === 1) return "ended";
  if (summary.last_event_at_ms === null) return "live";

  const idleFor = now - summary.last_event_at_ms;
  return idleFor > idleThresholdMs(summary.median_gap_ms) ? "likely-ended" : "live";
}

export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  ended: "Ended",
  "likely-ended": "Likely ended",
  live: "Live",
};
