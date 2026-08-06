import type { CodeEdge, CodeNode } from "./codegraph.js";

/**
 * Phase 3: reverse-dependency closure ("blast radius") over the Phase 2
 * import graph.
 *
 * File-level only, EXTRACTED-only — same scope boundary as the graph itself.
 * A type-only import, a dynamic require, or symbol-level usage can create
 * real coupling this never sees; that is a documented limitation (the same
 * one Phase 2 already lives with), not something this module tries to guess
 * its way around.
 *
 * Deliberately pure and synchronous: a BFS over data already sitting in
 * memory, no I/O, no model call. This is what makes it safe to run
 * fire-and-forget off the back of a PostToolUse event without touching the
 * agent loop's critical path.
 */

/**
 * Default reverse-closure depth.
 *
 * 3 hops, chosen for two reasons: it is deep enough to surface indirect
 * coupling through a shared re-export or a thin wrapper (common in this kind
 * of monorepo layout — see packages/shared/src/index.ts), while shallow
 * enough that in a small-to-medium repo it doesn't degrade into "most of the
 * graph," which would make the ranked list meaningless. Configurable per call
 * so a consumer can widen it for a small repo or narrow it for a huge one.
 */
export const DEFAULT_BLAST_RADIUS_DEPTH = 3;

export interface AffectedFile {
  filePath: string;
  /** Hops from the changed file, via reverse import edges. 1 = direct importer. */
  depth: number;
  /** In-degree over the WHOLE graph — how many files import this one, not just within this closure. */
  inDegree: number;
}

/** The wire shape: a BlastRadiusResult plus which step produced it. Same shape over REST and SSE. */
export interface BlastRadiusNote extends BlastRadiusResult {
  sessionId: string;
  toolUseId: string;
  createdAtMs: number;
}

export interface BlastRadiusResult {
  filePath: string;
  /** False when the changed file has no matching node — new, out of scope, or not yet indexed. */
  inGraph: boolean;
  maxDepth: number;
  /** True when the reverse closure was cut off by maxDepth while more importers existed beyond it. */
  truncated: boolean;
  /** Ranked by inDegree desc, then depth asc, then path — most-central files first. */
  affected: AffectedFile[];
  summary: string;
  /** Null when the heuristic found nothing worth flagging, or no affected files to check. */
  testCoverageNote: string | null;
}

function basename(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  return parts.at(-1) ?? filePath;
}

/** How many files import each node, over the whole graph — a simple, explainable centrality proxy. */
export function inDegreeOf(edges: CodeEdge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of edges) counts.set(e.to, (counts.get(e.to) ?? 0) + 1);
  return counts;
}

/**
 * Reverse BFS: from `startId`, follow edges backwards (to → from) up to
 * `maxDepth` hops. Returns each reached file's shortest hop count, and
 * whether stopping at maxDepth cut off real, unexplored importers.
 */
export function reverseClosure(
  edges: CodeEdge[],
  startId: string,
  maxDepth: number,
): { depths: Map<string, number>; truncated: boolean } {
  const importersOf = new Map<string, string[]>();
  for (const e of edges) {
    const list = importersOf.get(e.to) ?? [];
    list.push(e.from);
    importersOf.set(e.to, list);
  }

  const depths = new Map<string, number>([[startId, 0]]);
  let frontier = [startId];
  let depth = 0;

  while (frontier.length > 0 && depth < maxDepth) {
    depth++;
    const next: string[] = [];
    for (const id of frontier) {
      for (const importer of importersOf.get(id) ?? []) {
        if (!depths.has(importer)) {
          depths.set(importer, depth);
          next.push(importer);
        }
      }
    }
    frontier = next;
  }

  // Truncated iff the final frontier still has unvisited importers beyond
  // maxDepth — i.e. the walk stopped because of the depth cap, not because
  // it ran out of graph to explore.
  const truncated = frontier.some((id) => (importersOf.get(id) ?? []).some((imp) => !depths.has(imp)));

  depths.delete(startId);
  return { depths, truncated };
}

function isTestFile(filePath: string): boolean {
  const b = basename(filePath);
  return /\.(test|spec)\.[^/]+$/.test(b) || /(^|\/)(__tests__|test)\//.test(filePath);
}

/** Cheap heuristic only: same basename stem appearing in some test/spec file's path. Never claims more than that. */
function hasLikelyTestFile(filePath: string, allPaths: Set<string>): boolean {
  const stem = basename(filePath).replace(/\.[^/.]+$/, "");
  for (const p of allPaths) {
    if (isTestFile(p) && basename(p).startsWith(stem)) return true;
  }
  return false;
}

function buildTestCoverageNote(affected: AffectedFile[], allFilePaths: string[]): string | null {
  const allSet = new Set(allFilePaths);
  const nonTest = affected.filter((a) => !isTestFile(a.filePath));
  if (nonTest.length === 0) return null;
  const withoutTest = nonTest.filter((a) => !hasLikelyTestFile(a.filePath, allSet));
  if (withoutTest.length === 0) return null;
  return `${withoutTest.length} of ${nonTest.length} affected file(s) have no matching test file.`;
}

function buildSummary(filePath: string, affected: AffectedFile[], truncated: boolean, maxDepth: number): string {
  const changed = basename(filePath);
  const truncNote = truncated ? ` (closure may be incomplete — capped at depth ${maxDepth})` : "";
  if (affected.length === 0) {
    return `Claude changed ${changed} — no other indexed files import it${truncNote}.`;
  }
  const top = affected.slice(0, 3).map((a) => basename(a.filePath));
  const more = affected.length > top.length ? `, and ${affected.length - top.length} more` : "";
  return `Claude changed ${changed} — ${affected.length} file(s) depend on it: ${top.join(", ")}${more}${truncNote}.`;
}

/**
 * `repoRoot` is null when no graph has been extracted yet at all — a
 * distinct, plainer "not indexed yet" case from a file simply missing from
 * an existing graph (out of scope, or a brand-new file the debounced
 * re-extraction hasn't caught up to yet).
 */
export function computeBlastRadius(
  graph: { nodes: CodeNode[]; edges: CodeEdge[] },
  repoRoot: string | null,
  filePath: string,
  maxDepth: number = DEFAULT_BLAST_RADIUS_DEPTH,
): BlastRadiusResult {
  if (repoRoot === null) {
    return {
      filePath,
      inGraph: false,
      maxDepth,
      truncated: false,
      affected: [],
      summary: `Claude changed ${basename(filePath)} — the import graph hasn't been built yet for this repo, so blast radius can't be computed.`,
      testCoverageNote: null,
    };
  }

  const node = graph.nodes.find((n) => n.filePath === filePath);
  if (!node) {
    return {
      filePath,
      inGraph: false,
      maxDepth,
      truncated: false,
      affected: [],
      summary: `Claude changed ${basename(filePath)} — not in the import graph (new file, outside the indexed scope, or not yet re-extracted).`,
      testCoverageNote: null,
    };
  }

  const { depths, truncated } = reverseClosure(graph.edges, filePath, maxDepth);
  const inDegree = inDegreeOf(graph.edges);

  const affected = [...depths.entries()]
    .map(([fp, depth]) => ({ filePath: fp, depth, inDegree: inDegree.get(fp) ?? 0 }))
    .sort((a, b) => b.inDegree - a.inDegree || a.depth - b.depth || a.filePath.localeCompare(b.filePath));

  return {
    filePath,
    inGraph: true,
    maxDepth,
    truncated,
    affected,
    summary: buildSummary(filePath, affected, truncated, maxDepth),
    testCoverageNote: buildTestCoverageNote(
      affected,
      graph.nodes.map((n) => n.filePath),
    ),
  };
}
