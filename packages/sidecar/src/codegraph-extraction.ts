import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAndMapGraph, runExtraction } from "./graphify.js";
import type { Store } from "./db.js";

/**
 * Orchestrates when graphify runs, so the trigger points (2.3) stay thin.
 *
 * graphify is invoked only from here. Nothing in this file is ever called
 * synchronously from a hook handler — every call site wraps this in
 * `setImmediate`/a background task, the same discipline the sidecar already
 * uses for the transcript tailer and SSE broadcast.
 *
 * Every trigger — cold start and debounced re-extraction alike — runs a full
 * `graphify extract`, never `graphify update`. Benchmarked directly on this
 * repo before deciding (see the `incremental` option's doc comment in
 * graphify.ts): `update` produced a graph that measurably diverged from a
 * fresh extract of the identical tree after a single no-op comment edit, with
 * no time savings to justify the risk. A full extract on joystick's own
 * ~51-file repo runs in ~1.0-1.2s wall clock, which is the number that
 * determines whether Phase 3's live coupling is feasible on top of this.
 */

export interface ExtractionResult {
  ok: boolean;
  reason?: string;
  wallMs: number;
  nodeCount?: number;
  edgeCount?: number;
  droppedInferredCount?: number;
}

/**
 * A full `graphify extract --code-only` into a scratch directory under the
 * plugin's own data dir, then loaded, validated, and swapped into the store.
 *
 * Runs into a throwaway temp dir rather than `${repoRoot}/graphify-out/`
 * because `extract --out` supports an arbitrary output location and this
 * keeps graphify's output out of the user's working tree entirely — nothing
 * for them to `.gitignore`, accidentally commit, or even notice.
 */
export async function runFullExtraction(store: Store, repoRoot: string, dataDir: string): Promise<ExtractionResult> {
  const outDir = mkdtempSync(join(dataDir, "graphify-extract-"));
  try {
    const outcome = await runExtraction({ repoRoot, outDir, incremental: false });
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason ?? "graphify extract failed", wallMs: outcome.wallMs };
    }

    const mapped = readAndMapGraph(outDir);
    if (!mapped.ok) {
      // Fail loud in the log, but never crash the sidecar and never replace a
      // working cached graph with a broken one.
      console.error(`[joystick] graphify output rejected, keeping previous graph: ${mapped.reason}`);
      return { ok: false, reason: mapped.reason, wallMs: outcome.wallMs };
    }

    const contentHashes = hashFiles(repoRoot, mapped.graph.nodes.map((n) => n.filePath));
    store.replaceCodeGraph({
      graph: mapped.graph,
      repoRoot,
      extractionMode: "full",
      wallMs: outcome.wallMs,
      droppedInferredCount: mapped.droppedInferredCount,
      contentHashes,
    });

    return {
      ok: true,
      wallMs: outcome.wallMs,
      nodeCount: mapped.graph.nodes.length,
      edgeCount: mapped.graph.edges.length,
      droppedInferredCount: mapped.droppedInferredCount,
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * SHA-256 per file, relative to repoRoot. Computed by joystick, not graphify —
 * graphify's own output carries no content hash. This is what lets a future
 * consumer (Phase 3, or 2.4's own benchmark) tell "the graph changed because
 * this file's content actually changed" from "the graph churned for other
 * reasons," which the spike found graphify's own --update does measurably.
 */
export function hashFiles(repoRoot: string, filePaths: string[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const rel of filePaths) {
    try {
      const bytes = readFileSync(join(repoRoot, rel));
      hashes.set(rel, createHash("sha256").update(bytes).digest("hex"));
    } catch {
      // File deleted or moved since the extraction ran. No hash, not fatal.
    }
  }
  return hashes;
}
