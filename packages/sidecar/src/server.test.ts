import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server.js";
import { Store } from "./db.js";

let dir: string;
let app: ReturnType<typeof buildServer>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "joystick-test-"));
  app = buildServer({ store: new Store(join(dir, "test.db")) });
});

afterEach(async () => {
  await app.close();
  app.store.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = { session_id: "s1", transcript_path: "/t.jsonl", cwd: "/repo" };

async function post(body: unknown) {
  return app.inject({ method: "POST", url: "/events", payload: body as object });
}

describe("POST /events", () => {
  it("accepts a documented event and returns 204", async () => {
    const res = await post({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "toolu_1",
      tool_input: { file_path: "/repo/src/index.ts" },
    });
    expect(res.statusCode).toBe(204);

    const rows = app.store.recentEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("Read");
    expect(rows[0].tool_use_id).toBe("toolu_1");
    expect(rows[0].summary).toBe("Read src/index.ts");
  });

  it("assigns seq monotonically per session", async () => {
    for (let i = 0; i < 5; i++) {
      await post({ ...base, hook_event_name: "Stop", last_assistant_message: `m${i}` });
    }
    await post({ ...base, session_id: "s2", hook_event_name: "Stop" });

    const s1 = app.store.recentEvents(100, "s1").map((r) => r.seq);
    expect(s1).toEqual([5, 4, 3, 2, 1]);
    expect(app.store.recentEvents(100, "s2")[0].seq).toBe(1);
  });

  it("stores the raw payload verbatim, including undocumented fields", async () => {
    await post({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      some_field_the_docs_do_not_mention: { nested: [1, 2, 3] },
    });
    const raw = app.store.recentEvents()[0].raw as Record<string, unknown>;
    expect(raw.some_field_the_docs_do_not_mention).toEqual({ nested: [1, 2, 3] });
  });

  it("stores an unmodelled event rather than dropping it", async () => {
    const res = await post({ ...base, hook_event_name: "SomeFutureEvent", detail: "x" });
    expect(res.statusCode).toBe(204);
    expect(app.store.recentEvents()[0].hook_event_name).toBe("SomeFutureEvent");
  });

  it("rejects a payload with no session_id", async () => {
    const res = await post({ hook_event_name: "Stop" });
    expect(res.statusCode).toBe(400);
    expect(app.store.recentEvents()).toHaveLength(0);
  });

  it("carries agent_id and agent_type through for subagent attribution", async () => {
    await post({
      ...base,
      hook_event_name: "SubagentStart",
      agent_id: "agent_7",
      agent_type: "Explore",
    });
    await post({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Grep",
      tool_use_id: "toolu_9",
      agent_id: "agent_7",
      agent_type: "Explore",
      tool_input: { pattern: "foo" },
    });

    const rows = app.store.recentEvents();
    expect(rows.every((r) => r.agent_id === "agent_7")).toBe(true);
    expect(rows.every((r) => r.agent_type === "Explore")).toBe(true);
  });

  it("summarises a PostToolBatch from its tool_calls", async () => {
    await post({
      ...base,
      hook_event_name: "PostToolBatch",
      tool_calls: [
        { tool_name: "Read", tool_use_id: "a", tool_input: {}, output: "x" },
        { tool_name: "Bash", tool_use_id: "b", tool_input: {}, output: "y" },
      ],
    });
    expect(app.store.recentEvents()[0].summary).toBe("batch of 2: Read, Bash");
  });
});

describe("session tracking", () => {
  it("records a session from any event, not just SessionStart", async () => {
    await post({ ...base, hook_event_name: "PreToolUse", tool_name: "Read" });
    const sessions = app.store.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe("/repo");
    expect(sessions[0].event_count).toBe(1);
  });

  it("closes a session on SessionEnd", async () => {
    await post({ ...base, hook_event_name: "SessionStart", source: "startup" });
    await post({ ...base, hook_event_name: "SessionEnd", reason: "logout" });
    const s = app.store.sessions()[0];
    expect(s.source).toBe("startup");
    expect(s.end_reason).toBe("logout");
    expect(s.ended_at).not.toBeNull();
  });
});

describe("GET /health", () => {
  it("reports ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
