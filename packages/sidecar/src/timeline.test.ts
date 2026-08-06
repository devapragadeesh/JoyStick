import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTimeline,
  toolResponseOf,
  type EventRow,
  type ToolIntent,
} from "@joystick/shared";
import { buildServer } from "./server.js";
import { Store } from "./db.js";
import { parseEntries, readCompleteLines, resolveIntent, tailOnce } from "./transcript.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

let dir: string;
let app: ReturnType<typeof buildServer>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "joystick-p1-"));
  app = buildServer({ store: new Store(join(dir, "test.db")), tail: false, codeGraph: false });
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

async function ingest(name: string, overrides: Record<string, unknown> = {}): Promise<void> {
  for (const payload of loadFixture(name)) {
    await app.inject({ method: "POST", url: "/events", payload: { ...payload, ...overrides } });
  }
}

/** A minimal transcript in Claude Code's real shape: one content block per record. */
function writeTranscript(
  path: string,
  records: Array<{ uuid: string; parent?: string; text?: string; thinking?: string; toolUse?: { id: string; name: string } }>,
): void {
  const lines = records.map((r) => {
    const content = r.toolUse
      ? [{ type: "tool_use", id: r.toolUse.id, name: r.toolUse.name, input: {} }]
      : r.thinking !== undefined
        ? [{ type: "thinking", thinking: r.thinking }]
        : [{ type: "text", text: r.text ?? "" }];
    return JSON.stringify({
      type: "assistant",
      uuid: r.uuid,
      parentUuid: r.parent ?? null,
      message: { content },
    });
  });
  writeFileSync(path, `${lines.join("\n")}\n`);
}

describe("transcript tailer", () => {
  it("reads only complete lines and leaves a partial record unconsumed", () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":');

    const first = readCompleteLines(path, 0);
    expect(first.lines).toEqual(['{"a":1}', '{"b":2}']);
    // The half-written third record is not consumed.
    expect(first.nextOffset).toBe(16);

    // Once it is finished, the next poll picks it up without re-reading.
    writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const second = readCompleteLines(path, first.nextOffset);
    expect(second.lines).toEqual(['{"c":3}']);
  });

  it("does not crash on a truncated record mid-object", () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, '{"type":"assistant","uuid":"a","message":{"content":[{"type":"tex\n');
    const { lines } = readCompleteLines(path, 0);
    // The line is complete (has a newline) but corrupt — parsing must skip it.
    expect(() => parseEntries(lines, 0)).not.toThrow();
    expect(parseEntries(lines, 0)).toEqual([]);
  });

  it("restarts from zero when the file shrinks", () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, '{"a":1}\n{"b":2}\n');
    const first = readCompleteLines(path, 0);
    writeFileSync(path, '{"z":9}\n');
    const second = readCompleteLines(path, first.nextOffset);
    expect(second.reset).toBe(true);
    expect(second.lines).toEqual(['{"z":9}']);
  });

  it("parses each content block as its own record, as Claude Code writes them", () => {
    const path = join(dir, "t.jsonl");
    writeTranscript(path, [
      { uuid: "u1", text: "I'll read the config." },
      { uuid: "u2", parent: "u1", toolUse: { id: "toolu_a", name: "Read" } },
    ]);
    const { lines } = readCompleteLines(path, 0);
    const entries = parseEntries(lines, 0);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "text", line_index: 0 });
    expect(entries[1]).toMatchObject({ kind: "tool_use", tool_use_id: "toolu_a", line_index: 1 });
  });
});

describe("intent extraction", () => {
  const lookup = (entries: ReturnType<typeof parseEntries>) => (uuid: string) =>
    entries.filter((e) => e.uuid === uuid);

  it("takes the text of the preceding assistant record, verbatim", () => {
    const path = join(dir, "t.jsonl");
    writeTranscript(path, [
      { uuid: "u1", text: "I'll read the config first." },
      { uuid: "u2", parent: "u1", toolUse: { id: "toolu_a", name: "Read" } },
    ]);
    const entries = parseEntries(readCompleteLines(path, 0).lines, 0);
    const got = resolveIntent("u1", lookup(entries));

    expect(got.intent).toBe("I'll read the config first.");
    expect(got.source).toBe("text");
  });

  it("falls to thinking when there is no text block", () => {
    const path = join(dir, "t.jsonl");
    writeTranscript(path, [
      { uuid: "u1", thinking: "The retry path is the likely culprit." },
      { uuid: "u2", parent: "u1", toolUse: { id: "toolu_a", name: "Read" } },
    ]);
    const entries = parseEntries(readCompleteLines(path, 0).lines, 0);
    const got = resolveIntent("u1", lookup(entries));

    expect(got.intent).toBe("The retry path is the likely culprit.");
    expect(got.source).toBe("thinking");
  });

  it("returns null when the parent has no reasoning, inventing nothing", () => {
    expect(resolveIntent(null, () => [])).toEqual({ intent: null, source: null });
    expect(resolveIntent("missing", () => [])).toEqual({ intent: null, source: null });
  });
});

describe("verification 2 — intent integrity", () => {
  /**
   * The load-bearing test for the whole phase. Every intent shown must exist
   * verbatim in the transcript; anything else would mean the panel is putting
   * words in Claude's mouth.
   */
  it("every non-null intent is a verbatim substring of the transcript file", async () => {
    const events = loadFixture("parallel-subagents.jsonl");
    const transcriptPath = events[0].transcript_path as string;
    const transcript = readFileSync(transcriptPath, "utf8");

    await ingest("parallel-subagents.jsonl");
    tailOnce(app.store);

    const sessionId = events[0].session_id as string;
    const intents = app.store.toolIntents(sessionId);
    const nonNull = intents.filter((i) => i.intent !== null);

    expect(nonNull.length).toBeGreaterThan(0);
    for (const i of nonNull) {
      // JSON-encode to match how the string is stored in the JSONL, which also
      // proves no unescaping/reformatting crept in.
      const encoded = JSON.stringify(i.intent!).slice(1, -1);
      expect(transcript.includes(encoded)).toBe(true);
    }
  });

  it("marks the source of every non-null intent", async () => {
    await ingest("parallel-subagents.jsonl");
    tailOnce(app.store);
    const sessionId = loadFixture("parallel-subagents.jsonl")[0].session_id as string;
    for (const i of app.store.toolIntents(sessionId)) {
      if (i.intent === null) expect(i.intent_source).toBeNull();
      else expect(["text", "thinking"]).toContain(i.intent_source);
    }
  });
});

describe("verification 1 — display order beats arrival order", () => {
  it("orders by transcript position even where seq inverts", async () => {
    await ingest("parallel-subagents.jsonl");
    tailOnce(app.store);

    const sessionId = loadFixture("parallel-subagents.jsonl")[0].session_id as string;
    const events = app.store.recentEvents(500, sessionId);
    const intents = app.store.toolIntents(sessionId) as ToolIntent[];
    const turns = buildTimeline(events, intents);

    const roots = turns.flatMap((t) => t.rootSteps);
    const orders = roots.map((s) => s.displayOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);

    // The three Agent calls must appear in transcript order, which is the order
    // their tool_use records were written.
    const agents = roots.filter((s) => s.toolName === "Agent");
    expect(agents).toHaveLength(3);
    const positions = agents.map((a) => intents.find((i) => i.tool_use_id === a.id)!.transcript_pos);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("nests subagent steps inside their parent's position", async () => {
    await ingest("parallel-subagents.jsonl");
    tailOnce(app.store);

    const sessionId = loadFixture("parallel-subagents.jsonl")[0].session_id as string;
    const turns = buildTimeline(
      app.store.recentEvents(500, sessionId),
      app.store.toolIntents(sessionId) as ToolIntent[],
    );

    const turn = turns.find((t) => t.childrenByParent.size > 0);
    expect(turn).toBeDefined();

    for (const [parentId, children] of turn!.childrenByParent) {
      const parent = turn!.rootSteps.find((s) => s.id === parentId);
      expect(parent).toBeDefined();
      // Every child sorts after its parent and before the next root step.
      for (const child of children) {
        expect(child.displayOrder).toBeGreaterThan(parent!.displayOrder);
        expect(child.parentAttribution).toBe("linked");
      }
      const ordered = children.map((c) => c.displayOrder);
      expect([...ordered].sort((a, b) => a - b)).toEqual(ordered);
    }
  });
});

describe("verification 4 — unattributed steps stay separate", () => {
  it("renders unattributed subagent steps in their own group, not the root list", async () => {
    await ingest("unattributed-subagent.jsonl");
    const turns = buildTimeline(app.store.recentEvents(500, "unattributed-0001"), []);

    const turn = turns.find((t) => t.unattributedSteps.length > 0);
    expect(turn).toBeDefined();
    expect(turn!.unattributedSteps.length).toBeGreaterThan(0);
    expect(turn!.unattributedSteps.every((s) => s.parentAttribution === "unattributed")).toBe(true);

    // Never merged upward, never guessed into a parent.
    const rootIds = new Set(turn!.rootSteps.map((s) => s.id));
    expect(turn!.unattributedSteps.some((s) => rootIds.has(s.id))).toBe(false);
    expect(turn!.unattributedSteps.every((s) => s.parentStepId === null)).toBe(true);
  });

  it("does not drop them from the step count", async () => {
    await ingest("unattributed-subagent.jsonl");
    const turns = buildTimeline(app.store.recentEvents(500, "unattributed-0001"), []);
    const total = turns.reduce((n, t) => n + t.stepCount, 0);
    const rendered = turns.reduce(
      (n, t) =>
        n +
        t.rootSteps.length +
        t.unattributedSteps.length +
        [...t.childrenByParent.values()].reduce((m, c) => m + c.length, 0),
      0,
    );
    expect(rendered).toBe(total);
  });
});

describe("verification 5 — transcript lag and late insertion", () => {
  it("renders a step before the transcript exists, then moves it into place", async () => {
    await ingest("unattributed-subagent.jsonl");
    const events = app.store.recentEvents(500, "unattributed-0001");

    // No intents yet: the transcript has not been written.
    const before = buildTimeline(events, []);
    const readBefore = before.flatMap((t) => t.rootSteps).find((s) => s.toolName === "Read")!;
    expect(readBefore).toBeDefined();
    expect(readBefore.displayOrderProvisional).toBe(true);
    expect(readBefore.intent).toBeNull();

    // Transcript catches up, placing that call early in the file.
    const after = buildTimeline(events, [
      {
        tool_use_id: "toolu_notanagent",
        transcript_pos: 2,
        intent: "Checking the readme first.",
        intent_source: "text",
      },
    ]);
    const readAfter = after.flatMap((t) => t.rootSteps).find((s) => s.toolName === "Read")!;

    expect(readAfter.displayOrderProvisional).toBe(false);
    expect(readAfter.intent).toBe("Checking the readme first.");
    // It moved earlier, rather than staying appended at the end.
    expect(readAfter.displayOrder).toBeLessThan(readBefore.displayOrder);
  });

  it("keeps steps sorted after a late arrival lands out of arrival order", () => {
    const mk = (seq: number, id: string): EventRow => ({
      id: seq,
      seq,
      session_id: "s",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: id,
      agent_id: null,
      agent_type: null,
      prompt_id: null,
      received_at: new Date(1000 + seq).toISOString(),
      summary: "",
      parent_tool_use_id: null,
      parent_attribution: null,
      raw: { tool_input: { command: id } },
    });

    // Arrival order is a, b, c; transcript order is the reverse.
    const events = [mk(1, "a"), mk(2, "b"), mk(3, "c")];
    const intents: ToolIntent[] = [
      { tool_use_id: "a", transcript_pos: 30, intent: null, intent_source: null },
      { tool_use_id: "b", transcript_pos: 20, intent: null, intent_source: null },
      { tool_use_id: "c", transcript_pos: 10, intent: null, intent_source: null },
    ];

    const roots = buildTimeline(events, intents).flatMap((t) => t.rootSteps);
    expect(roots.map((s) => s.id)).toEqual(["c", "b", "a"]);
    expect(roots.map((s) => s.seq)).toEqual([3, 2, 1]);
  });
});

describe("verification 6 — turn grouping", () => {
  it("bounds turns by UserPromptSubmit and Stop", async () => {
    await ingest("sample-session.jsonl");
    const turns = buildTimeline(app.store.recentEvents(500, "fixture-0001"), []);
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toContain("Add retry logic");
    expect(turns[0].inProgress).toBe(false);
    expect(turns[0].durationMs).not.toBeNull();
  });

  it("splits multiple turns in one session", async () => {
    const base = { session_id: "multi", transcript_path: "/t", cwd: "/r" };
    const send = (p: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/events", payload: { ...base, ...p } });

    await send({ hook_event_name: "UserPromptSubmit", prompt: "first" });
    await send({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t1" });
    await send({ hook_event_name: "Stop", last_assistant_message: "done" });
    await send({ hook_event_name: "UserPromptSubmit", prompt: "second" });
    await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t2" });
    await send({ hook_event_name: "Stop", last_assistant_message: "done" });

    const turns = buildTimeline(app.store.recentEvents(500, "multi"), []);
    expect(turns).toHaveLength(2);
    expect(turns[0].prompt).toBe("first");
    expect(turns[1].prompt).toBe("second");
    expect(turns[0].rootSteps.map((s) => s.id)).toEqual(["t1"]);
    expect(turns[1].rootSteps.map((s) => s.id)).toEqual(["t2"]);
  });

  it("closes a turn when a new prompt arrives even with no Stop between them", async () => {
    // Caught in the panel: an open turn's bound runs to infinity, so without
    // this it claims every later turn's steps as its own.
    const base = { session_id: "nostop", transcript_path: "/t", cwd: "/r" };
    const send = (p: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/events", payload: { ...base, ...p } });

    await send({ hook_event_name: "UserPromptSubmit", prompt: "first" });
    await send({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "n1" });
    await send({ hook_event_name: "UserPromptSubmit", prompt: "second" });
    await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "n2" });
    await send({ hook_event_name: "UserPromptSubmit", prompt: "third" });
    await send({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "n3" });

    const turns = buildTimeline(app.store.recentEvents(500, "nostop"), []);
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.rootSteps.map((s) => s.id))).toEqual([["n1"], ["n2"], ["n3"]]);
    expect(turns.map((t) => t.stepCount)).toEqual([1, 1, 1]);
    // Only the newest turn is still running.
    expect(turns.map((t) => t.inProgress)).toEqual([false, false, true]);
  });

  it("renders an unterminated turn as in progress rather than erroring", async () => {
    const base = { session_id: "killed", transcript_path: "/t", cwd: "/r" };
    const send = (p: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/events", payload: { ...base, ...p } });

    // The Phase 0 kill-mid-session shape: no Stop, no SessionEnd.
    await send({ hook_event_name: "UserPromptSubmit", prompt: "do a thing" });
    await send({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "k1" });
    await send({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "k1" });
    await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "k2" });

    const turns = buildTimeline(app.store.recentEvents(500, "killed"), []);
    expect(turns).toHaveLength(1);
    expect(turns[0].inProgress).toBe(true);
    expect(turns[0].durationMs).toBeNull();
    expect(turns[0].stepCount).toBe(2);
    // The tool call that never resolved stays visible, marked in flight.
    expect(turns[0].rootSteps.find((s) => s.id === "k2")!.status).toBe("pending");
    expect(turns[0].rootSteps.find((s) => s.id === "k1")!.status).toBe("ok");
  });
});

describe("verification 9 — toolResponseOf coverage", () => {
  it("resolves a defined result for every PostToolUse in a real capture", () => {
    const posts = loadFixture("parallel-subagents.jsonl").filter(
      (p) => p.hook_event_name === "PostToolUse",
    );
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      expect(toolResponseOf(p)).toBeDefined();
    }
  });

  it("resolves a defined result for every PostToolBatch entry in a real capture", () => {
    const batches = loadFixture("parallel-subagents.jsonl").filter(
      (p) => p.hook_event_name === "PostToolBatch",
    );
    expect(batches.length).toBeGreaterThan(0);
    let entries = 0;
    for (const b of batches) {
      for (const call of b.tool_calls as Array<Record<string, unknown>>) {
        expect(toolResponseOf(call)).toBeDefined();
        entries++;
      }
    }
    expect(entries).toBeGreaterThan(0);
  });

  it("surfaces that output on the built step", async () => {
    await ingest("parallel-subagents.jsonl");
    const sessionId = loadFixture("parallel-subagents.jsonl")[0].session_id as string;
    const steps = buildTimeline(app.store.recentEvents(500, sessionId), []).flatMap((t) => [
      ...t.rootSteps,
      ...[...t.childrenByParent.values()].flat(),
    ]);
    const resolved = steps.filter((s) => s.status === "ok");
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.every((s) => s.output !== undefined && s.output.length > 0)).toBe(true);
  });
});

describe("step shaping", () => {
  it("marks a failed tool call as an error", async () => {
    await ingest("sample-session.jsonl");
    const steps = buildTimeline(app.store.recentEvents(500, "fixture-0001"), []).flatMap(
      (t) => t.rootSteps,
    );
    const failed = steps.find((s) => s.status === "error");
    expect(failed).toBeDefined();
    expect(failed!.toolName).toBe("Bash");
  });

  it("builds a diff from an Edit's before and after strings", async () => {
    await ingest("sample-session.jsonl");
    const steps = buildTimeline(app.store.recentEvents(500, "fixture-0001"), []).flatMap(
      (t) => t.rootSteps,
    );
    const edit = steps.find((s) => s.toolName === "Edit" && s.diff);
    expect(edit).toBeDefined();
    expect(edit!.diff).toContain("- ");
    expect(edit!.diff).toContain("+ ");
  });

  it("computes duration from the Pre/Post pair", async () => {
    await ingest("sample-session.jsonl");
    const steps = buildTimeline(app.store.recentEvents(500, "fixture-0001"), []).flatMap(
      (t) => t.rootSteps,
    );
    expect(steps.some((s) => s.durationMs !== undefined)).toBe(true);
    expect(steps.every((s) => (s.durationMs ?? 0) >= 0)).toBe(true);
  });
});
