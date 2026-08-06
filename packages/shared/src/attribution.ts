import type { EventRow } from "./index.js";

/**
 * Linking a subagent back to the Agent tool call that spawned it.
 *
 * Claude Code does not state this link. `SubagentStart` carries `agent_id` but
 * no `tool_use_id`, and the `Agent` tool's `PreToolUse` carries `tool_use_id`
 * but no `agent_id`. The link has to be inferred.
 *
 * The rule used here is spawn adjacency: each `Agent` PreToolUse is immediately
 * followed by the `SubagentStart` of the agent it spawned. That was verified
 * against three subagents launched in a single parallel batch — the three
 * Pre/Start pairs arrived interleaved with each other but never internally
 * split:
 *
 *     PreToolUse Agent tuid=A  →  SubagentStart agent=1
 *     PreToolUse Agent tuid=B  →  SubagentStart agent=2
 *     PreToolUse Agent tuid=C  →  SubagentStart agent=3
 *
 * This is inference over an undocumented ordering guarantee, so it is kept in
 * one function, applied after the fact, and never allowed to affect what gets
 * stored. Events whose parent cannot be determined get a null parent rather
 * than a guessed one.
 */

export interface AgentLink {
  agent_id: string;
  agent_type: string | null;
  /** tool_use_id of the spawning Agent call, or null when it can't be determined. */
  parent_tool_use_id: string | null;
  start_seq: number;
  stop_seq: number | null;
}

export function linkSubagents(events: EventRow[]): Map<string, AgentLink> {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const links = new Map<string, AgentLink>();

  /** Agent PreToolUse calls seen but not yet claimed by a SubagentStart. */
  const pendingSpawns: string[] = [];

  for (const e of ordered) {
    if (e.hook_event_name === "PreToolUse" && e.tool_name === "Agent" && e.tool_use_id) {
      pendingSpawns.push(e.tool_use_id);
      continue;
    }

    if (e.hook_event_name === "SubagentStart" && e.agent_id) {
      links.set(e.agent_id, {
        agent_id: e.agent_id,
        agent_type: e.agent_type,
        // Oldest unclaimed spawn: starts arrive in the order the Agent calls
        // were made, so FIFO is the correct pairing.
        parent_tool_use_id: pendingSpawns.shift() ?? null,
        start_seq: e.seq,
        stop_seq: null,
      });
      continue;
    }

    if (e.hook_event_name === "SubagentStop" && e.agent_id) {
      const link = links.get(e.agent_id);
      if (link) link.stop_seq = e.seq;
    }
  }

  return links;
}

/** Which agent an event belongs to; null means the main session. */
export function owningAgent(event: EventRow): string | null {
  return event.agent_id ?? null;
}
