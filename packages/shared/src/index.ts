export * from "./events.js";
export * from "./summary.js";
export * from "./attribution.js";

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
