import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTimeline, type ToolIntent } from "@joystick/shared";
import { buildServer } from "./server.js";
import { Store } from "./db.js";

/**
 * Regressions for two bugs that verification caught and review did not.
 *
 * Both existed because every fixture at the time was well-formed. These
 * fixtures are shaped specifically to reproduce the conditions that let each
 * bug hide, so a future change that reintroduces either one fails here.
 */

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

let dir: string;
let app: ReturnType<typeof buildServer>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "joystick-regression-"));
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

async function ingest(name: string): Promise<void> {
  for (const payload of loadFixture(name)) {
    await app.inject({ method: "POST", url: "/events", payload });
  }
}

describe("regression: backfill must move a step earlier, never later", () => {
  /**
   * The original bug parked provisional steps at `maxKnownPos + 1`, which is
   * position 1 when nothing is known yet — the *lowest* slot rather than the
   * highest. Backfilling then pushed steps later instead of earlier.
   *
   * A fixture where the provisional value happened to be the lowest possible
   * position would not have caught it, so this one backfills into the middle of
   * a run with positions already established on both sides.
   */
  it("moves a late-resolved step into its true middle position", async () => {
    await ingest("late-backfill.jsonl");
    const events = app.store.recentEvents(500, "late-backfill-0001");

    // Everything except the lagging step already has a transcript position.
    const partial: ToolIntent[] = [
      { tool_use_id: "toolu_early", transcript_pos: 10, intent: "Reading the first config.", intent_source: "text" },
      { tool_use_id: "toolu_middle", transcript_pos: 20, intent: null, intent_source: null },
      { tool_use_id: "toolu_last", transcript_pos: 40, intent: null, intent_source: null },
    ];

    const before = buildTimeline(events, partial).flatMap((t) => t.rootSteps);
    const laggingBefore = before.find((s) => s.id === "toolu_lagging")!;

    expect(laggingBefore.displayOrderProvisional).toBe(true);
    // It must park after every step whose position is known — not at the front.
    const known = before.filter((s) => !s.displayOrderProvisional);
    expect(known.length).toBe(3);
    for (const s of known) {
      expect(laggingBefore.displayOrder).toBeGreaterThan(s.displayOrder);
    }
    expect(before.at(-1)!.id).toBe("toolu_lagging");

    // The transcript catches up and places it between `middle` and `last`.
    const complete: ToolIntent[] = [
      ...partial,
      { tool_use_id: "toolu_lagging", transcript_pos: 30, intent: "Validating both files parse.", intent_source: "text" },
    ];
    const after = buildTimeline(events, complete).flatMap((t) => t.rootSteps);
    const laggingAfter = after.find((s) => s.id === "toolu_lagging")!;

    expect(laggingAfter.displayOrderProvisional).toBe(false);
    // The property the original bug violated.
    expect(laggingAfter.displayOrder).toBeLessThan(laggingBefore.displayOrder);
    expect(laggingAfter.intent).toBe("Validating both files parse.");

    expect(after.map((s) => s.id)).toEqual([
      "toolu_early",
      "toolu_middle",
      "toolu_lagging",
      "toolu_last",
    ]);
  });

  it("keeps every provisional step after every positioned step", async () => {
    await ingest("late-backfill.jsonl");
    const events = app.store.recentEvents(500, "late-backfill-0001");
    const only = [
      { tool_use_id: "toolu_middle", transcript_pos: 20, intent: null, intent_source: null },
    ] as ToolIntent[];

    const steps = buildTimeline(events, only).flatMap((t) => t.rootSteps);
    const positioned = steps.filter((s) => !s.displayOrderProvisional);
    const provisional = steps.filter((s) => s.displayOrderProvisional);

    expect(positioned).toHaveLength(1);
    expect(provisional.length).toBeGreaterThan(0);
    const worstPositioned = Math.max(...positioned.map((s) => s.displayOrder));
    for (const p of provisional) {
      expect(p.displayOrder).toBeGreaterThan(worstPositioned);
    }
  });
});

describe("regression: an unterminated turn must not swallow later turns", () => {
  /**
   * The original bug left a turn with no Stop bounded at infinity, so it
   * claimed every subsequent turn's steps. The Phase 0 kill case did not catch
   * it because the killed turn was the *last* turn, where an unbounded end is
   * harmless. Here the unterminated turn sits in the middle.
   */
  it("bounds a middle turn that never received a Stop", async () => {
    await ingest("unbounded-turn.jsonl");
    const turns = buildTimeline(app.store.recentEvents(500, "unbounded-turn-0001"), []);

    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.rootSteps.map((s) => s.id))).toEqual([
      ["toolu_t1a"],
      ["toolu_t2a", "toolu_t2b"],
      ["toolu_t3a", "toolu_t3b"],
    ]);
    expect(turns.map((t) => t.stepCount)).toEqual([1, 2, 2]);
  });

  it("does not mark a superseded turn as still in progress", async () => {
    await ingest("unbounded-turn.jsonl");
    const turns = buildTimeline(app.store.recentEvents(500, "unbounded-turn-0001"), []);

    // Turn 2 never got a Stop, but a later prompt proves it is over.
    expect(turns[1].durationMs).toBeNull();
    expect(turns.map((t) => t.inProgress)).toEqual([false, false, false]);
  });

  it("keeps the unresolved call inside the killed turn marked in flight", async () => {
    await ingest("unbounded-turn.jsonl");
    const turns = buildTimeline(app.store.recentEvents(500, "unbounded-turn-0001"), []);
    const killed = turns[1].rootSteps.find((s) => s.id === "toolu_t2b")!;

    expect(killed.status).toBe("pending");
    expect(turns[1].rootSteps.find((s) => s.id === "toolu_t2a")!.status).toBe("ok");
  });

  it("assigns every step to exactly one turn", async () => {
    await ingest("unbounded-turn.jsonl");
    const turns = buildTimeline(app.store.recentEvents(500, "unbounded-turn-0001"), []);
    const ids = turns.flatMap((t) => t.rootSteps.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
  });
});

describe("subagent groups are narrated by delegation, not by invented intent", () => {
  it("carries the delegation prompt and returned summary on the Agent step", async () => {
    await ingest("parallel-subagents.jsonl");
    const sessionId = loadFixture("parallel-subagents.jsonl")[0].session_id as string;
    const turns = buildTimeline(app.store.recentEvents(500, sessionId), []);

    const agents = turns.flatMap((t) => t.rootSteps).filter((s) => s.toolName === "Agent");
    expect(agents).toHaveLength(3);

    for (const a of agents) {
      expect(a.kind).toBe("subagent");
      expect(a.delegationPrompt).toBeTruthy();
      expect(a.returnedSummary).toBeTruthy();
    }
  });

  it("fabricates no intent anywhere inside a subagent group", async () => {
    await ingest("parallel-subagents.jsonl");
    const sessionId = loadFixture("parallel-subagents.jsonl")[0].session_id as string;
    const turns = buildTimeline(app.store.recentEvents(500, sessionId), []);

    const nested = turns.flatMap((t) => [...t.childrenByParent.values()].flat());
    expect(nested.length).toBeGreaterThan(0);
    // Subagent reasoning is not in the parent transcript and sidechains are not
    // ingested, so every nested step must be honestly null.
    expect(nested.every((s) => s.intent === null)).toBe(true);
    expect(nested.every((s) => s.intentSource === null)).toBe(true);
  });

  it("orders subagent-internal steps by seq within their group", async () => {
    // The documented deviation from "transcript order wins": there is no
    // transcript position for these steps, so seq is the only ordering there is.
    await ingest("parallel-subagents.jsonl");
    const sessionId = loadFixture("parallel-subagents.jsonl")[0].session_id as string;
    const turns = buildTimeline(app.store.recentEvents(500, sessionId), []);

    let groupsChecked = 0;
    for (const turn of turns) {
      for (const children of turn.childrenByParent.values()) {
        expect(children.length).toBeGreaterThan(0);
        const seqs = children.map((c) => c.seq);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
        const orders = children.map((c) => c.displayOrder);
        expect([...orders].sort((a, b) => a - b)).toEqual(orders);
        groupsChecked++;
      }
    }
    expect(groupsChecked).toBe(3);
  });

  it("keeps each group anchored inside its parent's transcript slot", async () => {
    await ingest("parallel-subagents.jsonl");
    const sessionId = loadFixture("parallel-subagents.jsonl")[0].session_id as string;
    const intents: ToolIntent[] = [
      { tool_use_id: "toolu_01RArmKnRgUXxcGfuRSjshjg", transcript_pos: 7, intent: null, intent_source: null },
      { tool_use_id: "toolu_013Y9AyrVArbikdDcrognJPR", transcript_pos: 8, intent: null, intent_source: null },
      { tool_use_id: "toolu_012hVf8yLSgoYtJm9KuTpZsE", transcript_pos: 9, intent: null, intent_source: null },
    ];
    const turns = buildTimeline(app.store.recentEvents(500, sessionId), intents);
    const turn = turns.find((t) => t.childrenByParent.size === 3)!;

    for (const [parentId, children] of turn.childrenByParent) {
      const parent = turn.rootSteps.find((s) => s.id === parentId)!;
      const nextParentOrder = parent.displayOrder + 1_000_000;
      for (const c of children) {
        expect(c.displayOrder).toBeGreaterThan(parent.displayOrder);
        // Never leaks into the next root step's slot.
        expect(c.displayOrder).toBeLessThan(nextParentOrder);
      }
    }
  });
});
