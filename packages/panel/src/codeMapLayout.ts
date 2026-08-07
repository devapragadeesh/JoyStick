import type { CodeGraph } from "@joystick/shared";
import type { ElementDefinition } from "cytoscape";

/**
 * Compound-node element list for the import graph.
 *
 * A.1 replaced Phase 2's manual two-state (collapsed-aggregate vs
 * fully-expanded) toggle with Cytoscape's native compound-node model: every
 * directory is a real parent node, every file a real child node, and
 * `cytoscape-expand-collapse` owns showing/hiding children and rerouting
 * their edges — not this module. That is what makes "expand in place, still
 * connected to the rest of the graph" a property of the extension rather than
 * something joystick has to reimplement.
 *
 * This module's only job now is producing the full, always-present element
 * list once. Every edge carries `edgeType: "imports"` so the extension's
 * `groupEdgesOfSameTypeOnCollapse` can roll multiple child-level imports
 * between the same two (now-collapsed) directories into one edge, rather than
 * leaving parallel duplicates.
 */

export function dirOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "." : filePath.slice(0, idx);
}

export function basename(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  return parts.at(-1) ?? filePath;
}

export function dirNodeId(dirPath: string): string {
  return `dir:${dirPath}`;
}

/** Direct file children of a directory node — same one-level relationship
 * the compound graph itself uses (see toCompoundElements), not a recursive
 * filesystem walk. */
export function filesInDir(graph: CodeGraph, dirPath: string): string[] {
  return graph.nodes.filter((n) => dirOf(n.filePath) === dirPath).map((n) => n.filePath);
}

export function toCompoundElements(graph: CodeGraph): ElementDefinition[] {
  const dirFileCounts = new Map<string, number>();
  for (const n of graph.nodes) {
    const d = dirOf(n.filePath);
    dirFileCounts.set(d, (dirFileCounts.get(d) ?? 0) + 1);
  }

  const dirNodes: ElementDefinition[] = [...dirFileCounts.entries()].map(([dir, count]) => ({
    data: { id: dirNodeId(dir), type: "dir", label: `${dir}/`, dirPath: dir, fileCount: count },
  }));

  const fileNodes: ElementDefinition[] = graph.nodes.map((n) => ({
    data: {
      id: n.filePath,
      type: "file",
      label: basename(n.filePath),
      filePath: n.filePath,
      parent: dirNodeId(dirOf(n.filePath)),
    },
  }));

  const edges: ElementDefinition[] = graph.edges.map((e, i) => ({
    data: {
      id: `edge:${i}:${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      edgeType: "imports",
    },
  }));

  return [...dirNodes, ...fileNodes, ...edges];
}

export interface NodeDetail {
  kind: "file" | "dir";
  label: string;
  filePath?: string;
  dirPath?: string;
  fileCount?: number;
  importsCount: number;
  importedByCount: number;
}

/** Detail shown in the on-select panel. Counts are direct (one-hop) only. */
export function nodeDetail(graph: CodeGraph, nodeId: string, isDir: boolean, dirPath?: string): NodeDetail {
  if (isDir && dirPath !== undefined) {
    const files = new Set(filesInDir(graph, dirPath));
    const imports = graph.edges.filter((e) => files.has(e.from) && !files.has(e.to)).length;
    const importedBy = graph.edges.filter((e) => files.has(e.to) && !files.has(e.from)).length;
    return {
      kind: "dir",
      label: `${dirPath}/`,
      dirPath,
      fileCount: files.size,
      importsCount: imports,
      importedByCount: importedBy,
    };
  }

  const imports = graph.edges.filter((e) => e.from === nodeId).length;
  const importedBy = graph.edges.filter((e) => e.to === nodeId).length;
  return {
    kind: "file",
    label: basename(nodeId),
    filePath: nodeId,
    importsCount: imports,
    importedByCount: importedBy,
  };
}

/** All distinct basenames that occur more than once, for label-disambiguation tests. */
export function duplicateBasenames(graph: CodeGraph): Map<string, string[]> {
  const byBasename = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const b = basename(n.filePath);
    const list = byBasename.get(b) ?? [];
    list.push(n.filePath);
    byBasename.set(b, list);
  }
  for (const [b, paths] of byBasename) if (paths.length < 2) byBasename.delete(b);
  return byBasename;
}
