import { computeBlastRadius, type BlastRadiusNote } from "@joystick/shared";
import type { Broker } from "./sse.js";
import type { Store } from "./db.js";
import { toRepoRelative } from "./paths.js";
import { config } from "./config.js";

/**
 * Phase 3: react to a PostToolUse Edit/Write by computing its reverse-
 * dependency closure over the already-cached graph, persisting the result,
 * and pushing it live over SSE.
 *
 * Always called from `setImmediate` in server.ts, after /events has already
 * responded — this is a fire-and-forget reaction to a completed hook event,
 * never something the agent loop waits on. The computation itself is a pure,
 * synchronous, in-memory BFS (see blastRadius.ts), so there is nothing to
 * await here beyond the DB write.
 */
export function reactToEdit(
  store: Store,
  broker: Broker,
  input: { sessionId: string; toolUseId: string; absOrRelFilePath: string },
): void {
  const meta = store.codeGraphMeta();
  const graph = store.codeGraph();
  const repoRoot = meta?.repo_root ?? null;
  const filePath = repoRoot ? toRepoRelative(repoRoot, input.absOrRelFilePath) : input.absOrRelFilePath;

  const result = computeBlastRadius(graph, repoRoot, filePath, config.blastRadiusMaxDepth);
  const createdAtMs = Date.now();

  store.insertBlastRadiusNote({
    sessionId: input.sessionId,
    toolUseId: input.toolUseId,
    filePath: result.filePath,
    inGraph: result.inGraph,
    truncated: result.truncated,
    maxDepth: result.maxDepth,
    affected: result.affected,
    summary: result.summary,
    testNote: result.testCoverageNote,
    createdAtMs,
  });

  const note: BlastRadiusNote = { sessionId: input.sessionId, toolUseId: input.toolUseId, createdAtMs, ...result };
  broker.publishNamed("blast-radius", note);
}
