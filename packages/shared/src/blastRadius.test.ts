import { describe, expect, it } from "vitest";
import type { CodeEdge, CodeGraph } from "./codegraph.js";
import { computeBlastRadius, inDegreeOf, reverseClosure } from "./blastRadius.js";

function node(filePath: string) {
  return { id: filePath, kind: "file" as const, label: filePath, filePath };
}
function edge(from: string, to: string): CodeEdge {
  return { from, to, kind: "imports", source: "graphify-extracted" };
}

// a -> b -> c -> d -> e  (a chain 4 hops deep)
// plus f, g both importing b directly (so b has high in-degree)
function chainGraph(): CodeGraph {
  return {
    nodes: ["a", "b", "c", "d", "e", "f", "g"].map(node),
    edges: [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "d"),
      edge("d", "e"),
      edge("f", "b"),
      edge("g", "b"),
    ],
    extractedAt: "2026-01-01T00:00:00.000Z",
    builtAtCommit: null,
  };
}

describe("reverseClosure", () => {
  it("walks reverse import edges up to maxDepth hops", () => {
    const { depths, truncated } = reverseClosure(chainGraph().edges, "e", 3);
    // e is imported by d (1), d by c (2), c by b (3) — stops there, b's own
    // importers (a, f, g) are one hop beyond the cap.
    expect(depths.get("d")).toBe(1);
    expect(depths.get("c")).toBe(2);
    expect(depths.get("b")).toBe(3);
    expect(depths.has("a")).toBe(false);
    expect(truncated).toBe(true);
  });

  it("is not truncated when the whole closure fits inside maxDepth", () => {
    const { depths, truncated } = reverseClosure(chainGraph().edges, "e", 10);
    expect(depths.get("a")).toBe(4);
    expect(depths.get("f")).toBe(4);
    expect(depths.get("g")).toBe(4);
    expect(truncated).toBe(false);
  });

  it("returns an empty closure for a file nothing imports", () => {
    const { depths, truncated } = reverseClosure(chainGraph().edges, "a", 3);
    expect(depths.size).toBe(0);
    expect(truncated).toBe(false);
  });
});

describe("inDegreeOf", () => {
  it("counts direct importers per file over the whole graph", () => {
    const counts = inDegreeOf(chainGraph().edges);
    expect(counts.get("b")).toBe(3); // a, f, g
    expect(counts.get("c")).toBe(1);
    expect(counts.get("a")).toBeUndefined();
  });
});

describe("computeBlastRadius", () => {
  it("ranks the closure by in-degree first, not just by hop distance", () => {
    const result = computeBlastRadius(chainGraph(), "/repo", "e", 10);
    expect(result.inGraph).toBe(true);
    // b (in-degree 3, depth 3) should outrank c/d (in-degree 1, closer depth).
    expect(result.affected[0].filePath).toBe("b");
    expect(result.affected.map((a) => a.filePath)).toEqual(
      expect.arrayContaining(["b", "c", "d", "a", "f", "g"]),
    );
  });

  it("flags truncation in both the result and the summary text", () => {
    const result = computeBlastRadius(chainGraph(), "/repo", "e", 2);
    expect(result.truncated).toBe(true);
    expect(result.summary).toMatch(/incomplete/);
  });

  it("never claims truncation when the closure is exhaustive", () => {
    const result = computeBlastRadius(chainGraph(), "/repo", "e", 10);
    expect(result.truncated).toBe(false);
    expect(result.summary).not.toMatch(/incomplete/);
  });

  it("says plainly when a file has no importers", () => {
    const result = computeBlastRadius(chainGraph(), "/repo", "a", 3);
    expect(result.inGraph).toBe(true);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toMatch(/no other indexed files import it/);
  });

  it("says plainly when the file isn't in the graph at all", () => {
    const result = computeBlastRadius(chainGraph(), "/repo", "not-tracked.ts", 3);
    expect(result.inGraph).toBe(false);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toMatch(/not in the import graph/);
  });

  it("says plainly when there is no graph at all yet", () => {
    const result = computeBlastRadius(chainGraph(), null, "a", 3);
    expect(result.inGraph).toBe(false);
    expect(result.summary).toMatch(/hasn't been built yet/);
  });

  it("flags affected files with no matching test file, and only those", () => {
    const graph: CodeGraph = {
      nodes: [node("src/util.ts"), node("src/util.test.ts"), node("src/a.ts"), node("src/b.ts")].concat(
        // b has a matching test, a does not
        [node("src/b.test.ts")],
      ),
      edges: [edge("src/a.ts", "src/util.ts"), edge("src/b.ts", "src/util.ts")],
      extractedAt: "2026-01-01T00:00:00.000Z",
      builtAtCommit: null,
    };
    const result = computeBlastRadius(graph, "/repo", "src/util.ts", 3);
    expect(result.testCoverageNote).toBe("1 of 2 affected file(s) have no matching test file.");
  });

  it("never flags a test file itself as untested", () => {
    const graph: CodeGraph = {
      nodes: [node("src/util.ts"), node("src/util.test.ts")],
      edges: [edge("src/util.test.ts", "src/util.ts")],
      extractedAt: "2026-01-01T00:00:00.000Z",
      builtAtCommit: null,
    };
    const result = computeBlastRadius(graph, "/repo", "src/util.ts", 3);
    expect(result.testCoverageNote).toBeNull();
  });
});
