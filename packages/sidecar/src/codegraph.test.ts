import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeGraph } from "@joystick/shared";
import { Store } from "./db.js";
import { CodeGraphScheduler, isEditTrigger } from "./codegraph-triggers.js";
import { buildServer } from "./server.js";
import type { ExtractionResult } from "./codegraph-extraction.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "joystick-codegraph-"));
  store = new Store(join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function sampleGraph(): CodeGraph {
  return {
    nodes: [
      { id: "a.ts", kind: "file", label: "a.ts", filePath: "a.ts" },
      { id: "b.ts", kind: "file", label: "b.ts", filePath: "b.ts" },
    ],
    edges: [{ from: "a.ts", to: "b.ts", kind: "imports", source: "graphify-extracted" }],
    extractedAt: new Date().toISOString(),
    builtAtCommit: "abc123",
  };
}

describe("Store: code graph persistence", () => {
  it("round-trips a graph through replaceCodeGraph", () => {
    store.replaceCodeGraph({
      graph: sampleGraph(),
      repoRoot: "/repo",
      extractionMode: "full",
      wallMs: 1234,
      droppedInferredCount: 3,
      contentHashes: new Map([["a.ts", "hash-a"]]),
    });

    const { nodes, edges } = store.codeGraph();
    expect(nodes).toHaveLength(2);
    expect(edges).toEqual([{ from: "a.ts", to: "b.ts", kind: "imports", source: "graphify-extracted" }]);

    const meta = store.codeGraphMeta();
    expect(meta?.repo_root).toBe("/repo");
    expect(meta?.extraction_mode).toBe("full");
    expect(meta?.wall_ms).toBe(1234);
    expect(meta?.dropped_inferred_count).toBe(3);
    expect(meta?.node_count).toBe(2);
    expect(meta?.edge_count).toBe(1);
  });

  it("fully replaces the previous graph rather than merging", () => {
    store.replaceCodeGraph({
      graph: sampleGraph(),
      repoRoot: "/repo",
      extractionMode: "full",
      wallMs: 100,
      droppedInferredCount: 0,
      contentHashes: new Map(),
    });

    const second: CodeGraph = {
      nodes: [{ id: "c.ts", kind: "file", label: "c.ts", filePath: "c.ts" }],
      edges: [],
      extractedAt: new Date().toISOString(),
      builtAtCommit: null,
    };
    store.replaceCodeGraph({
      graph: second,
      repoRoot: "/repo",
      extractionMode: "full",
      wallMs: 50,
      droppedInferredCount: 0,
      contentHashes: new Map(),
    });

    const { nodes, edges } = store.codeGraph();
    expect(nodes).toEqual([{ id: "c.ts", kind: "file", label: "c.ts", filePath: "c.ts" }]);
    expect(edges).toHaveLength(0);
  });

  it("returns null meta and empty graph before any extraction has run", () => {
    expect(store.codeGraphMeta()).toBeNull();
    expect(store.codeGraph()).toEqual({ nodes: [], edges: [] });
  });

  it("recovers content hashes keyed by file path", () => {
    store.replaceCodeGraph({
      graph: sampleGraph(),
      repoRoot: "/repo",
      extractionMode: "full",
      wallMs: 1,
      droppedInferredCount: 0,
      contentHashes: new Map([
        ["a.ts", "hash-a"],
        ["b.ts", "hash-b"],
      ]),
    });
    expect(store.codeGraphContentHashes()).toEqual(
      new Map([
        ["a.ts", "hash-a"],
        ["b.ts", "hash-b"],
      ]),
    );
  });
});

describe("isEditTrigger", () => {
  it("fires on PostToolUse for Edit, Write, NotebookEdit", () => {
    expect(isEditTrigger("PostToolUse", "Edit")).toBe(true);
    expect(isEditTrigger("PostToolUse", "Write")).toBe(true);
    expect(isEditTrigger("PostToolUse", "NotebookEdit")).toBe(true);
  });

  it("does not fire for read-only tools or other events", () => {
    expect(isEditTrigger("PostToolUse", "Read")).toBe(false);
    expect(isEditTrigger("PostToolUse", "Bash")).toBe(false);
    expect(isEditTrigger("PreToolUse", "Edit")).toBe(false);
    expect(isEditTrigger("PostToolUse", null)).toBe(false);
    expect(isEditTrigger("PostToolUse", undefined)).toBe(false);
  });
});

describe("CodeGraphScheduler", () => {
  it("ensureInitialGraph runs an extraction when no graph is cached", async () => {
    const extract = vi.fn(async (): Promise<ExtractionResult> => ({ ok: true, wallMs: 5, nodeCount: 1, edgeCount: 0 }));
    const scheduler = new CodeGraphScheduler(store, dir, extract, 10);

    scheduler.ensureInitialGraph("/repo");
    await flush();

    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledWith(store, "/repo", dir);
  });

  it("ensureInitialGraph is a no-op once a graph is already cached", async () => {
    store.replaceCodeGraph({
      graph: sampleGraph(),
      repoRoot: "/repo",
      extractionMode: "full",
      wallMs: 1,
      droppedInferredCount: 0,
      contentHashes: new Map(),
    });
    const extract = vi.fn(async (): Promise<ExtractionResult> => ({ ok: true, wallMs: 1 }));
    const scheduler = new CodeGraphScheduler(store, dir, extract, 10);

    scheduler.ensureInitialGraph("/repo");
    await flush();

    expect(extract).not.toHaveBeenCalled();
  });

  it("debounces: several edits within the window produce exactly one extraction", async () => {
    const extract = vi.fn(async (): Promise<ExtractionResult> => ({ ok: true, wallMs: 1 }));
    const scheduler = new CodeGraphScheduler(store, dir, extract, 30);

    scheduler.notifyEdit("/repo");
    await new Promise((r) => setTimeout(r, 10));
    scheduler.notifyEdit("/repo"); // resets the window
    await new Promise((r) => setTimeout(r, 10));
    scheduler.notifyEdit("/repo"); // resets again

    expect(extract).not.toHaveBeenCalled(); // window never elapsed uninterrupted
    await new Promise((r) => setTimeout(r, 50));

    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("coalesces an edit that arrives while an extraction is already in flight", async () => {
    let resolveFirst!: (v: ExtractionResult) => void;
    const first = new Promise<ExtractionResult>((r) => (resolveFirst = r));
    const extract = vi
      .fn<Extractor>()
      .mockImplementationOnce(() => first)
      .mockImplementation(async () => ({ ok: true, wallMs: 1 }));
    const scheduler = new CodeGraphScheduler(store, dir, extract, 5);

    scheduler.notifyEdit("/repo");
    await new Promise((r) => setTimeout(r, 15)); // first extraction now in flight
    expect(extract).toHaveBeenCalledTimes(1);

    scheduler.notifyEdit("/repo"); // arrives mid-flight
    await new Promise((r) => setTimeout(r, 15)); // its own debounce window elapses
    expect(extract).toHaveBeenCalledTimes(1); // still just the one in flight — no second timer fired yet because coalescing takes over

    resolveFirst({ ok: true, wallMs: 1 });
    await flush();

    expect(extract).toHaveBeenCalledTimes(2); // exactly one follow-up, not one per edit
  });

  it("does not crash the scheduler when an extraction fails", async () => {
    const extract = vi.fn(async (): Promise<ExtractionResult> => ({ ok: false, reason: "boom", wallMs: 1 }));
    const scheduler = new CodeGraphScheduler(store, dir, extract, 5);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    scheduler.ensureInitialGraph("/repo");
    await flush();

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("does not crash the scheduler when the extractor throws", async () => {
    const extract = vi.fn(async (): Promise<ExtractionResult> => {
      throw new Error("subprocess exploded");
    });
    const scheduler = new CodeGraphScheduler(store, dir, extract, 5);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    scheduler.ensureInitialGraph("/repo");
    await flush();

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

/**
 * Server-level: with the code-graph scheduler disabled (the test default,
 * matching every other suite), /events still responds fast — establishing the
 * baseline that verification 6 then compares a *slowed real subprocess*
 * against, the same sleep-injection method Phase 0 used for the hook path.
 */
describe("server: /events responds immediately regardless of graphify state", () => {
  it("returns 204 in well under the ~50ms hook budget", async () => {
    const app = buildServer({ store, tail: false, codeGraph: false });
    const start = performance.now();
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { session_id: "s", hook_event_name: "SessionStart", cwd: "/repo" },
    });
    const elapsedMs = performance.now() - start;

    expect(res.statusCode).toBe(204);
    expect(elapsedMs).toBeLessThan(50);
    await app.close();
  });
});

async function flush(): Promise<void> {
  // Let pending microtasks/timers created by the scheduler's promise chains settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

type Extractor = (
  store: Store,
  repoRoot: string,
  dataDir: string,
) => Promise<ExtractionResult>;
