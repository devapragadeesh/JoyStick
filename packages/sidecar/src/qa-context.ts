import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTimeline, truncateForContext, type AssembledContext, type FileContext } from "@joystick/shared";
import type { Store } from "./db.js";

/**
 * Provider-agnostic context assembly (B.3).
 *
 * Built once per question, then handed to whichever provider answers it —
 * there is exactly one code path here regardless of which of the three
 * provider kinds ends up using the result. Nothing here ever fabricates: a
 * file that can't be read, or has no touching timeline steps, says so
 * explicitly rather than being silently omitted.
 */

async function readFileSafely(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return null;
  }
}

export async function assembleContext(store: Store, sessionId: string, filePaths: string[]): Promise<AssembledContext> {
  const meta = store.codeGraphMeta();
  const graph = store.codeGraph();

  const events = store.recentEvents(5000, sessionId);
  const intents = store.toolIntents(sessionId);
  const turns = buildTimeline(events, intents);
  const allSteps = turns.flatMap((t) => [
    ...t.rootSteps,
    ...t.unattributedSteps,
    ...[...t.childrenByParent.values()].flat(),
  ]);

  // A step's `target` is whatever the tool call's own input carried — for
  // Edit/Write/Read that's an absolute filesystem path, while the code graph
  // (and the filePaths this function is called with) uses repo-relative
  // paths throughout. Without normalizing, no step ever matches any file.
  const repoRoot = meta?.repo_root;
  const relativeTarget = (target: string | undefined): string | undefined => {
    if (!target) return undefined;
    if (repoRoot && target.startsWith(`${repoRoot}/`)) return target.slice(repoRoot.length + 1);
    return target;
  };

  const files: FileContext[] = [];

  for (const filePath of filePaths) {
    const raw = meta ? await readFileSafely(join(meta.repo_root, filePath)) : null;
    const { text, truncated } = raw !== null ? truncateForContext(raw) : { text: "", truncated: false };

    const imports = graph.edges.filter((e) => e.from === filePath).map((e) => e.to);
    const importedBy = graph.edges.filter((e) => e.to === filePath).map((e) => e.from);

    const touchingSteps = allSteps.filter((s) => relativeTarget(s.target) === filePath);
    const withIntent = touchingSteps.filter((s) => s.intent !== null);
    const timelineNote =
      touchingSteps.length === 0
        ? "no timeline steps touched this file in this session"
        : withIntent.length === 0
          ? `${touchingSteps.length} timeline step(s) touched this file, none with a stated reasoning found`
          : `${touchingSteps.length} timeline step(s) touched this file, ${withIntent.length} with a stated reason`;

    files.push({
      filePath,
      content: raw === null ? "" : text,
      truncated: raw === null ? false : truncated,
      imports,
      importedBy,
      timelineSteps: touchingSteps.map((s) => ({
        sessionId: s.sessionId,
        toolName: s.toolName ?? null,
        intent: s.intent,
        status: s.status,
      })),
      timelineNote: raw === null ? `could not read ${filePath} from disk — ${timelineNote}` : timelineNote,
    });
  }

  return { files };
}
