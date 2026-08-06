import { describe, expect, it } from "vitest";
import type { CodeGraph } from "@joystick/shared";
import {
  allDirectories,
  basename,
  buildVisibleGraph,
  dirNodeId,
  dirOf,
  directNeighbors,
  resolveVisibleId,
} from "./codeMapLayout.js";

const graph: CodeGraph = {
  extractedAt: "2026-01-01T00:00:00.000Z",
  builtAtCommit: null,
  nodes: [
    { id: "a", kind: "file", label: "a", filePath: "src/App.tsx" },
    { id: "b", kind: "file", label: "b", filePath: "src/Picker.tsx" },
    { id: "c", kind: "file", label: "c", filePath: "shared/util.ts" },
    { id: "d", kind: "file", label: "d", filePath: "shared/other.ts" },
  ],
  edges: [
    { from: "src/App.tsx", to: "src/Picker.tsx", kind: "imports", source: "graphify-extracted" },
    { from: "src/App.tsx", to: "shared/util.ts", kind: "imports", source: "graphify-extracted" },
    { from: "src/Picker.tsx", to: "shared/util.ts", kind: "imports", source: "graphify-extracted" },
    { from: "shared/other.ts", to: "shared/util.ts", kind: "imports", source: "graphify-extracted" },
  ],
};

describe("path helpers", () => {
  it("extracts a directory from a file path", () => {
    expect(dirOf("src/App.tsx")).toBe("src");
    expect(dirOf("a/b/c/d.ts")).toBe("a/b/c");
  });

  it("treats a root-level file as directory '.'", () => {
    expect(dirOf("index.ts")).toBe(".");
  });

  it("extracts a basename", () => {
    expect(basename("a/b/c/App.tsx")).toBe("App.tsx");
    expect(basename("index.ts")).toBe("index.ts");
  });
});

describe("buildVisibleGraph: fully collapsed (default view)", () => {
  const { nodes, edges } = buildVisibleGraph(graph, new Set());

  it("shows exactly one node per directory", () => {
    expect(nodes).toHaveLength(2);
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toEqual([dirNodeId("shared"), dirNodeId("src")].sort());
    expect(nodes.every((n) => n.type === "dir")).toBe(true);
  });

  it("counts files per directory correctly", () => {
    const shared = nodes.find((n) => n.id === dirNodeId("shared"));
    const src = nodes.find((n) => n.id === dirNodeId("src"));
    expect(shared?.type === "dir" && shared.fileCount).toBe(2);
    expect(src?.type === "dir" && src.fileCount).toBe(2);
  });

  it("rolls up all cross-directory edges into one, and drops intra-directory edges", () => {
    // src/App->src/Picker and shared/other->shared/util both collapse to
    // self-loops and are dropped; the two src->shared edges collapse to one.
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: dirNodeId("src"), target: dirNodeId("shared"), weight: 2 });
  });
});

describe("buildVisibleGraph: one directory expanded", () => {
  const { nodes, edges } = buildVisibleGraph(graph, new Set(["src"]));

  it("shows individual files for the expanded directory, an aggregate for the other", () => {
    const fileNodes = nodes.filter((n) => n.type === "file");
    const dirNodes = nodes.filter((n) => n.type === "dir");
    expect(fileNodes.map((n) => n.id).sort()).toEqual(["src/App.tsx", "src/Picker.tsx"]);
    expect(dirNodes).toHaveLength(1);
    expect(dirNodes[0].id).toBe(dirNodeId("shared"));
  });

  it("shows the real file-to-file edge inside the expanded directory", () => {
    expect(edges).toContainEqual(
      expect.objectContaining({ source: "src/App.tsx", target: "src/Picker.tsx", weight: 1 }),
    );
  });

  it("resolves edges from an expanded file to the still-collapsed directory aggregate", () => {
    const toShared = edges.filter((e) => e.target === dirNodeId("shared"));
    // App.tsx->util.ts and Picker.tsx->util.ts both point at the same collapsed target.
    expect(toShared).toHaveLength(2);
    expect(toShared.map((e) => e.source).sort()).toEqual(["src/App.tsx", "src/Picker.tsx"]);
  });
});

describe("buildVisibleGraph: fully expanded", () => {
  const { nodes, edges } = buildVisibleGraph(graph, new Set(["src", "shared"]));

  it("shows every file as its own node", () => {
    expect(nodes).toHaveLength(4);
    expect(nodes.every((n) => n.type === "file")).toBe(true);
  });

  it("shows every original edge, one-to-one", () => {
    expect(edges).toHaveLength(4);
  });
});

describe("resolveVisibleId", () => {
  it("resolves to the directory aggregate when collapsed", () => {
    expect(resolveVisibleId("src/App.tsx", new Set())).toBe(dirNodeId("src"));
  });
  it("resolves to the file itself when its directory is expanded", () => {
    expect(resolveVisibleId("src/App.tsx", new Set(["src"]))).toBe("src/App.tsx");
  });
});

describe("directNeighbors", () => {
  it("finds neighbors in either direction, no multi-hop", () => {
    const { edges } = buildVisibleGraph(graph, new Set(["src", "shared"]));
    const neighbors = directNeighbors(edges, "shared/util.ts");
    // util.ts is imported by three files; none of those files' own further
    // neighbors should appear.
    expect(neighbors).toEqual(new Set(["src/App.tsx", "src/Picker.tsx", "shared/other.ts"]));
  });

  it("returns an empty set for a node with no edges", () => {
    const { edges } = buildVisibleGraph(graph, new Set(["src", "shared"]));
    expect(directNeighbors(edges, "nonexistent.ts")).toEqual(new Set());
  });
});

describe("allDirectories", () => {
  it("lists every distinct directory, sorted", () => {
    expect(allDirectories(graph)).toEqual(["shared", "src"]);
  });
});
