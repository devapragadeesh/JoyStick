import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkSubagents, toolResponseOf, type EventRow } from "@joystick/shared";
import { buildServer } from "./server.js";
import { Store } from "./db.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

let dir: string;
let app: ReturnType<typeof buildServer>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "joystick-closeout-"));
  app = buildServer({ store: new Store(join(dir, "test.db")) });
});

afterEach(async () => {
  await app.close();
  app.store.close();
  rmSync(dir, { recursive: true, force: true });
});

function loadFixture(name: string): Array<Record<string, unknown>> {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Replay a fixture through the real ingest path, so attribution is written as it would be live. */
async function ingest(name: string): Promise<void> {
  for (const payload of loadFixture(name)) {
    const res = await app.inject({ method: "POST", url: "/events", payload });
    expect(res.statusCode).toBe(204);
  }
}

describe("parent attribution is written at ingest time", () => {
  it("links every subagent event in the real three-subagent capture", async () => {
    await ingest("parallel-subagents.jsonl");

    const subagentEvents = app.store
      .recentEvents(500)
      .filter((e) => e.agent_id !== null);

    expect(subagentEvents.length).toBeGreaterThan(0);
    expect(subagentEvents.every((e) => e.parent_attribution === "linked")).toBe(true);
    expect(subagentEvents.every((e) => e.parent_tool_use_id !== null)).toBe(true);
  });

  it("reports a zero unattributed rate for that capture", async () => {
    await ingest("parallel-subagents.jsonl");
    const [stats] = app.store.attributionStats();
    expect(stats.unattributed_subagent_events).toBe(0);
    expect(stats.unattributed_pct).toBe(0);
    expect(stats.total_subagent_events).toBeGreaterThan(0);
  });

  it("agrees with the offline linker on which parent each agent got", async () => {
    // The store resolves attribution incrementally in SQL; linkSubagents does it
    // in one pass over the finished list. They must not drift apart.
    await ingest("parallel-subagents.jsonl");
    const rows = app.store.recentEvents(500);
    const links = linkSubagents(rows);

    for (const [agentId, link] of links) {
      const written = rows.find(
        (r) => r.agent_id === agentId && r.hook_event_name === "SubagentStart",
      );
      expect(written?.parent_tool_use_id).toBe(link.parent_tool_use_id);
      expect(written?.parent_attribution).toBe(link.parent_attribution);
    }
  });

  it("leaves non-subagent events with no attribution at all", async () => {
    await ingest("parallel-subagents.jsonl");
    const root = app.store.recentEvents(500).filter((e) => e.agent_id === null);
    expect(root.length).toBeGreaterThan(0);
    // Phase 0 does not invent "root" — that is Phase 1's rendering concern.
    expect(root.every((e) => e.parent_attribution === null)).toBe(true);
  });
});

describe("unattributed is a real state, not a dropped event", () => {
  it("marks a subagent with no spawning Agent call as unattributed", async () => {
    await ingest("unattributed-subagent.jsonl");

    const subagentEvents = app.store
      .recentEvents(500)
      .filter((e) => e.agent_id !== null);

    // SubagentStart, PreToolUse, PostToolUse, PostToolBatch, SubagentStop.
    expect(subagentEvents.length).toBe(5);
    expect(subagentEvents.every((e) => e.parent_attribution === "unattributed")).toBe(true);
    expect(subagentEvents.every((e) => e.parent_tool_use_id === null)).toBe(true);
  });

  it("keeps unattributed events in the log rather than discarding them", async () => {
    await ingest("unattributed-subagent.jsonl");
    const all = app.store.recentEvents(500);
    expect(all).toHaveLength(loadFixture("unattributed-subagent.jsonl").length);
  });

  it("counts them in the attribution view", async () => {
    await ingest("unattributed-subagent.jsonl");
    const [stats] = app.store.attributionStats("unattributed-0001");
    expect(stats.unattributed_subagent_events).toBe(stats.total_subagent_events);
    expect(stats.unattributed_pct).toBe(100);
  });

  it("forces the offline linker down its null branch too", async () => {
    const rows: EventRow[] = loadFixture("unattributed-subagent.jsonl").map((p, i) => ({
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
      parent_tool_use_id: null,
      parent_attribution: null,
      raw: p,
    }));

    const links = linkSubagents(rows);
    expect(links.size).toBe(1);
    const link = links.get("agent_orphan")!;
    expect(link.parent_attribution).toBe("unattributed");
    // The Read call before it is not an Agent call and must never be borrowed.
    expect(link.parent_tool_use_id).toBeNull();
  });
});

describe("session liveness facts", () => {
  it("records last_event_at and no explicit end for a truncated session", async () => {
    // Everything up to, but not including, any Stop or SessionEnd.
    const payloads = loadFixture("unattributed-subagent.jsonl").filter(
      (p) => p.hook_event_name !== "Stop" && p.hook_event_name !== "SessionEnd",
    );
    for (const payload of payloads) {
      await app.inject({ method: "POST", url: "/events", payload });
    }

    const [row] = app.store.liveness("unattributed-0001") as Array<Record<string, unknown>>;
    expect(row.last_event_at).toBeTruthy();
    expect(row.last_event_at_ms).toBeGreaterThan(0);
    expect(row.explicit_end_received).toBe(0);
    expect(row.stop_received).toBe(0);
    expect(row.session_end_received).toBe(0);
    expect(row.last_end_kind).toBeNull();
  });

  it("distinguishes a Stop from a SessionEnd", async () => {
    await ingest("unattributed-subagent.jsonl"); // ends with Stop, no SessionEnd
    const [row] = app.store.liveness("unattributed-0001") as Array<Record<string, unknown>>;
    // A Stop ends a turn, not a session — recorded, but kept distinct.
    expect(row.stop_received).toBe(1);
    expect(row.session_end_received).toBe(0);
    expect(row.explicit_end_received).toBe(1);
    expect(row.last_end_kind).toBe("Stop");
  });

  it("advances last_event_at as events arrive", async () => {
    await app.inject({
      method: "POST",
      url: "/events",
      payload: { session_id: "t1", hook_event_name: "SessionStart" },
    });
    const first = (app.store.liveness("t1") as Array<Record<string, number>>)[0].last_event_at_ms;

    await new Promise((r) => setTimeout(r, 5));
    await app.inject({
      method: "POST",
      url: "/events",
      payload: { session_id: "t1", hook_event_name: "PreToolUse", tool_name: "Read" },
    });
    const second = (app.store.liveness("t1") as Array<Record<string, number>>)[0].last_event_at_ms;

    expect(second).toBeGreaterThan(first);
  });

  it("does not compute an ended verdict", async () => {
    await ingest("unattributed-subagent.jsonl");
    const [row] = app.store.liveness("unattributed-0001") as Array<Record<string, unknown>>;
    // Phase 0 exposes facts only; any "ended"/"likely ended" key would mean the
    // idle heuristic leaked out of the panel and into storage.
    expect(Object.keys(row)).not.toContain("state");
    expect(Object.keys(row)).not.toContain("is_ended");
  });
});

describe("tool result field name", () => {
  it("reads tool_response from a real captured PostToolUse", () => {
    const post = loadFixture("parallel-subagents.jsonl").find(
      (p) => p.hook_event_name === "PostToolUse",
    )!;
    expect(Object.keys(post)).toContain("tool_response");
    expect(Object.keys(post)).not.toContain("tool_result");
    expect(toolResponseOf(post)).toBeDefined();
  });

  it("reads tool_response from a real captured PostToolBatch entry", () => {
    const batch = loadFixture("parallel-subagents.jsonl").find(
      (p) => p.hook_event_name === "PostToolBatch",
    )!;
    const calls = batch.tool_calls as Array<Record<string, unknown>>;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(Object.keys(call)).toContain("tool_response");
      expect(Object.keys(call)).not.toContain("output");
      expect(toolResponseOf(call)).toBeDefined();
    }
  });

  it("still resolves the documented names if a future version emits them", () => {
    expect(toolResponseOf({ output: "a" })).toBe("a");
    expect(toolResponseOf({ tool_result: "b" })).toBe("b");
    // Observed name wins when more than one is present.
    expect(toolResponseOf({ tool_response: "x", output: "y" })).toBe("x");
    expect(toolResponseOf(undefined)).toBeUndefined();
  });
});
