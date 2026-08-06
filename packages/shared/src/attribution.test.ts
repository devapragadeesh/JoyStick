import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { linkSubagents } from "./attribution.js";
import type { EventRow } from "./index.js";

/**
 * These run against a real capture: three Explore subagents launched in one
 * parallel batch during a live Claude Code session. Synthetic fixtures would
 * not have caught the interleaving this file exists to handle.
 */
const fixture = join(import.meta.dirname, "..", "..", "..", "fixtures", "parallel-subagents.jsonl");

const events: EventRow[] = readFileSync(fixture, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line, i) => {
    const p = JSON.parse(line) as Record<string, unknown>;
    return {
      id: i + 1,
      seq: i + 1,
      session_id: p.session_id as string,
      hook_event_name: p.hook_event_name as string,
      tool_name: (p.tool_name as string) ?? null,
      tool_use_id: (p.tool_use_id as string) ?? null,
      agent_id: (p.agent_id as string) ?? null,
      agent_type: (p.agent_type as string) ?? null,
      prompt_id: (p.prompt_id as string) ?? null,
      received_at: new Date().toISOString(),
      summary: "",
      raw: p,
    };
  });

describe("linkSubagents on a real parallel-subagent capture", () => {
  const links = linkSubagents(events);

  it("finds all three subagents", () => {
    expect(links.size).toBe(3);
    expect([...links.values()].every((l) => l.agent_type === "Explore")).toBe(true);
  });

  it("gives every subagent a distinct parent Agent call", () => {
    const parents = [...links.values()].map((l) => l.parent_tool_use_id);
    expect(parents.every((p) => p !== null)).toBe(true);
    expect(new Set(parents).size).toBe(3);
  });

  it("pairs each subagent with the Agent call that actually spawned it", () => {
    // Ground truth, cross-checked against the independent stop-side ordering:
    // each SubagentStop is followed by the PostToolUse of its own Agent call.
    expect(links.get("a3c7bc2228f95511c")?.parent_tool_use_id).toBe(
      "toolu_01RArmKnRgUXxcGfuRSjshjg",
    );
    expect(links.get("aa9809911be133578")?.parent_tool_use_id).toBe(
      "toolu_013Y9AyrVArbikdDcrognJPR",
    );
    expect(links.get("af32e2f4723b267c9")?.parent_tool_use_id).toBe(
      "toolu_012hVf8yLSgoYtJm9KuTpZsE",
    );
  });

  it("agrees with the stop-side pairing derived independently", () => {
    // Rebuild the mapping a second way: the PostToolUse of an Agent call is the
    // first Agent PostToolUse after that agent's SubagentStop.
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    const stopSide = new Map<string, string>();
    for (let i = 0; i < ordered.length; i++) {
      const e = ordered[i];
      if (e.hook_event_name !== "SubagentStop" || !e.agent_id) continue;
      const post = ordered
        .slice(i + 1)
        .find((x) => x.hook_event_name === "PostToolUse" && x.tool_name === "Agent");
      if (post?.tool_use_id) stopSide.set(e.agent_id, post.tool_use_id);
    }

    for (const [agentId, link] of links) {
      expect(link.parent_tool_use_id).toBe(stopSide.get(agentId));
    }
  });

  it("records a stop for every subagent that finished", () => {
    expect([...links.values()].every((l) => l.stop_seq !== null)).toBe(true);
    for (const l of links.values()) {
      expect(l.stop_seq!).toBeGreaterThan(l.start_seq);
    }
  });

  it("attributes every subagent-internal tool call to a known agent", () => {
    const inner = events.filter((e) => e.agent_id && e.hook_event_name === "PreToolUse");
    expect(inner.length).toBeGreaterThan(0);
    expect(inner.every((e) => links.has(e.agent_id!))).toBe(true);
  });

  it("leaves the parent null rather than guessing when no spawn was seen", () => {
    const orphan = events.filter((e) => e.hook_event_name === "SubagentStart");
    const withoutSpawns = linkSubagents(
      events.filter((e) => !(e.tool_name === "Agent" && e.hook_event_name === "PreToolUse")),
    );
    expect(withoutSpawns.size).toBe(orphan.length);
    expect([...withoutSpawns.values()].every((l) => l.parent_tool_use_id === null)).toBe(true);
  });
});
