import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapGraphifyOutput } from "./codegraph.js";

const FIXTURE = join(import.meta.dirname, "..", "..", "..", "fixtures", "graphify-graph.json");
const real = JSON.parse(readFileSync(FIXTURE, "utf8"));

describe("mapGraphifyOutput on a real captured graph.json", () => {
  it("succeeds and produces file nodes and import edges", () => {
    const result = mapGraphifyOutput(real);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.nodes.length).toBeGreaterThan(0);
    expect(result.graph.edges.length).toBeGreaterThan(0);
    expect(result.graph.nodes.every((n) => n.kind === "file")).toBe(true);
    expect(result.graph.edges.every((e) => e.kind === "imports")).toBe(true);
    expect(result.graph.edges.every((e) => e.source === "graphify-extracted")).toBe(true);
  });

  it("drops every INFERRED edge before it reaches CodeEdge", () => {
    const result = mapGraphifyOutput(real);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inferredInRaw = real.links.filter((l: { confidence: string }) => l.confidence === "INFERRED");
    expect(inferredInRaw.length).toBeGreaterThan(0); // the fixture must actually contain some
    expect(result.droppedInferredCount).toBe(inferredInRaw.length);

    // Every mapped edge traces back to an EXTRACTED import/imports_from link.
    // File-level dedup and same-file collapse legitimately shrink this count
    // further (covered by the dedup and no-self-edge tests below), so this
    // only asserts an upper bound, not equality.
    const extractedImportCount = real.links.filter(
      (l: { confidence: string; relation: string }) =>
        l.confidence === "EXTRACTED" && (l.relation === "imports" || l.relation === "imports_from"),
    ).length;
    expect(result.graph.edges.length).toBeLessThanOrEqual(extractedImportCount);
    expect(result.graph.edges.length).toBeGreaterThan(0);
  });

  it("finds the known App.tsx -> SessionPicker.tsx import, spot-checked against real source", () => {
    const result = mapGraphifyOutput(real);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const edge = result.graph.edges.find(
      (e) => e.from === "packages/panel/src/App.tsx" && e.to === "packages/panel/src/SessionPicker.tsx",
    );
    expect(edge).toBeDefined();
  });

  it("never emits a self-edge for a file that imports its own symbols", () => {
    const result = mapGraphifyOutput(real);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.edges.every((e) => e.from !== e.to)).toBe(true);
  });

  it("deduplicates multiple symbol-level imports between the same two files", () => {
    const result = mapGraphifyOutput(real);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pairs = result.graph.edges.map((e) => `${e.from}->${e.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("includes files with no import edges as isolated nodes", () => {
    const result = mapGraphifyOutput(real);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const connected = new Set(result.graph.edges.flatMap((e) => [e.from, e.to]));
    const isolated = result.graph.nodes.filter((n) => !connected.has(n.id));
    // Config/entry files with no resolved TS import target are expected to be
    // isolated rather than silently dropped from the node set.
    expect(isolated.length).toBeGreaterThan(0);
  });

  it("carries the commit the extraction ran against", () => {
    const result = mapGraphifyOutput(real);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.builtAtCommit).toBe(real.built_at_commit);
  });
});

describe("mapGraphifyOutput schema validation", () => {
  it("fails loud on a shape missing the real 'links' key", () => {
    const result = mapGraphifyOutput({ nodes: [], edges: [] }); // the README-implied, wrong shape
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("nodes, links");
  });

  it("fails loud on nodes missing required fields", () => {
    const result = mapGraphifyOutput({ nodes: [{ id: "x" }], links: [] });
    expect(result.ok).toBe(false);
  });

  it("fails loud on completely unrelated JSON", () => {
    const result = mapGraphifyOutput({ hello: "world" });
    expect(result.ok).toBe(false);
  });

  it("fails loud on null and non-object input", () => {
    expect(mapGraphifyOutput(null).ok).toBe(false);
    expect(mapGraphifyOutput("a string").ok).toBe(false);
    expect(mapGraphifyOutput(42).ok).toBe(false);
  });

  it("accepts a minimal valid shape with zero edges", () => {
    const result = mapGraphifyOutput({
      nodes: [{ id: "a", label: "a.ts", source_file: "a.ts" }],
      links: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.nodes).toHaveLength(1);
    expect(result.graph.edges).toHaveLength(0);
  });
});
