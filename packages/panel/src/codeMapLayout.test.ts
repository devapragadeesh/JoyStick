import { describe, expect, it } from "vitest";
import type { CodeGraph } from "@joystick/shared";
import { basename, dirNodeId, dirOf, duplicateBasenames, nodeDetail, toCompoundElements } from "./codeMapLayout.js";

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

describe("toCompoundElements", () => {
  const elements = toCompoundElements(graph);
  const nodes = elements.filter((e) => !e.data.source);
  const edges = elements.filter((e) => e.data.source);

  it("emits one compound node per directory", () => {
    const dirs = nodes.filter((n) => n.data.type === "dir");
    expect(dirs.map((n) => n.data.id).sort()).toEqual([dirNodeId("shared"), dirNodeId("src")].sort());
  });

  it("emits one node per file, parented to its directory's compound node", () => {
    const files = nodes.filter((n) => n.data.type === "file");
    expect(files).toHaveLength(4);
    const app = files.find((n) => n.data.id === "src/App.tsx");
    expect(app?.data.parent).toBe(dirNodeId("src"));
    expect(app?.data.label).toBe("App.tsx"); // basename, not full path
  });

  it("counts files per directory on the compound node", () => {
    const src = nodes.find((n) => n.data.id === dirNodeId("src"));
    expect(src?.data.fileCount).toBe(2);
  });

  it("emits every edge once, at file granularity, tagged for extension-native rollup", () => {
    expect(edges).toHaveLength(4);
    expect(edges.every((e) => e.data.edgeType === "imports")).toBe(true);
    expect(edges).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ source: "src/App.tsx", target: "shared/util.ts" }) }),
    );
  });

  it("never emits duplicate node ids", () => {
    const ids = nodes.map((n) => n.data.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("nodeDetail", () => {
  it("reports direct import counts for a file node", () => {
    const detail = nodeDetail(graph, "src/App.tsx", false);
    expect(detail).toMatchObject({ kind: "file", filePath: "src/App.tsx", label: "App.tsx", importsCount: 2, importedByCount: 0 });
  });

  it("reports cross-directory import counts for a directory node", () => {
    // src/App->shared/util and src/Picker->shared/util both cross into "shared".
    const detail = nodeDetail(graph, dirNodeId("shared"), true, "shared");
    expect(detail).toMatchObject({ kind: "dir", dirPath: "shared", fileCount: 2, importedByCount: 2, importsCount: 0 });
  });

  it("excludes intra-directory imports from a directory's cross-boundary count", () => {
    // shared/other -> shared/util is internal to "shared" and must not count
    // as an external import in either direction.
    const detail = nodeDetail(graph, dirNodeId("shared"), true, "shared");
    expect(detail.importsCount).toBe(0);
  });
});

describe("duplicateBasenames", () => {
  it("finds no duplicates when every basename is unique", () => {
    expect(duplicateBasenames(graph).size).toBe(0);
  });

  it("finds files that share a basename across different directories", () => {
    const withDup: CodeGraph = {
      ...graph,
      nodes: [...graph.nodes, { id: "e", kind: "file", label: "e", filePath: "shared/App.tsx" }],
    };
    const dups = duplicateBasenames(withDup);
    expect(dups.get("App.tsx")?.sort()).toEqual(["shared/App.tsx", "src/App.tsx"]);
  });
});
