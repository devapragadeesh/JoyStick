import { runFullExtraction, type ExtractionResult } from "./codegraph-extraction.js";
import type { Store } from "./db.js";

type Extractor = (store: Store, repoRoot: string, dataDir: string) => Promise<ExtractionResult>;

/**
 * The only two places graphify ever runs from: a cold start with no cached
 * graph, and a debounced re-extraction after edits settle. graphify has no
 * schedule, hook, or trigger of its own in this project — see graphify.ts.
 *
 * Both entry points are fire-and-forget from the caller's perspective. Nothing
 * here is awaited by a hook response; POST /events has already returned 204
 * before either of these can run, matching the same "persist first, respond
 * immediately, derive later" discipline the rest of the sidecar uses.
 */

/** Debounce window: edits within this long of each other collapse into one extraction. */
export const DEBOUNCE_MS = 2500;

export class CodeGraphScheduler {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private pendingRepoRoot: string | null = null;

  constructor(
    private store: Store,
    private dataDir: string,
    /** Injectable for tests, which need debounce/coalescing behavior without a real subprocess. */
    private extract: Extractor = runFullExtraction,
    private debounceMs: number = DEBOUNCE_MS,
  ) {}

  /** SessionStart: back-fill a graph if the cache is empty. Runs once, not on every session. */
  ensureInitialGraph(repoRoot: string): void {
    if (this.store.codeGraphMeta()) return;
    this.scheduleNow(repoRoot);
  }

  /** Unconditional trigger, cache state notwithstanding. For manual refresh only. */
  forceExtraction(repoRoot: string): void {
    this.scheduleNow(repoRoot);
  }

  /** PostToolUse for Edit/Write/NotebookEdit: reset the debounce window. */
  notifyEdit(repoRoot: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduleNow(repoRoot);
    }, this.debounceMs);
    this.timer.unref();
  }

  private scheduleNow(repoRoot: string): void {
    if (this.inFlight) {
      // An extraction is already running; one more edit lands while it's in
      // flight. Coalesce to a single follow-up run rather than queuing N.
      this.pendingRepoRoot = repoRoot;
      return;
    }
    this.inFlight = true;
    void this.extract(this.store, repoRoot, this.dataDir)
      .then((result) => {
        if (!result.ok) {
          console.error(`[joystick] graphify extraction failed: ${result.reason ?? "unknown error"}`);
        }
      })
      .catch((err: unknown) => {
        console.error(`[joystick] graphify extraction threw: ${(err as Error).message}`);
      })
      .finally(() => {
        this.inFlight = false;
        if (this.pendingRepoRoot) {
          const next = this.pendingRepoRoot;
          this.pendingRepoRoot = null;
          this.scheduleNow(next);
        }
      });
  }

  /** Test/shutdown hook: cancel any pending debounce timer. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

export function isEditTrigger(hookEventName: string, toolName: string | null | undefined): boolean {
  return hookEventName === "PostToolUse" && !!toolName && EDIT_TOOLS.has(toolName);
}
