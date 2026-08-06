/**
 * Phase 1 verification evidence.
 *
 * Prints the orderings and coverage numbers referenced in the README, from a
 * live sidecar, so the report is reproducible rather than transcribed.
 *
 *   pnpm verify
 */
import { buildTimeline, type EventRow, type ToolIntent } from "@joystick/shared";

const port = process.env.JOYSTICK_PORT ?? "8787";
const base = `http://127.0.0.1:${port}`;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const sessions = await get<Array<{ session_id: string; title: string | null }>>("/api/sessions");
  const target = sessions.find((s) => (s.title ?? "").includes("THREE Explore"));
  if (!target) {
    console.error("The parallel-subagent session is not loaded. Replay it first.");
    process.exit(1);
  }

  const id = target.session_id;
  const events = await get<EventRow[]>(`/api/events?limit=2000&session_id=${id}`);
  const intents = await get<ToolIntent[]>(`/api/intents?session_id=${id}`);
  const turns = buildTimeline(events, intents);

  console.log(`session ${id}\n`);

  console.log("VERIFICATION 1 — arrival order vs display order");
  console.log("  Root steps as they arrived (seq), and as they render (displayOrder):\n");
  const roots = turns.flatMap((t) => t.rootSteps);
  console.log("    seq   displayOrder   tPos  tool   target");
  for (const s of roots) {
    const pos = intents.find((i) => i.tool_use_id === s.id)?.transcript_pos ?? "—";
    console.log(
      `    ${String(s.seq).padStart(3)}   ${String(s.displayOrder).padStart(12)}   ${String(pos).padStart(4)}  ${(s.toolName ?? "").padEnd(6)} ${(s.target ?? "").slice(0, 40)}`,
    );
  }

  // The documented inversion: the batch summary arrives before its own member.
  const inverted = events
    .filter((e) => e.hook_event_name === "PostToolBatch" || e.tool_name === "Agent")
    .sort((a, b) => a.seq - b.seq)
    .map((e) => `${e.seq}:${e.hook_event_name}`);
  console.log(`\n  Raw arrival sequence around the inversion:\n    ${inverted.join("  ")}`);

  console.log("\nVERIFICATION 3 — intent coverage");
  const all = [...roots, ...turns.flatMap((t) => [...t.childrenByParent.values()].flat())];
  const withIntent = all.filter((s) => s.intent !== null);
  console.log(`  steps: ${all.length}   with intent: ${withIntent.length}   null: ${all.length - withIntent.length}`);
  for (const s of withIntent) {
    console.log(`    [${s.intentSource}] ${JSON.stringify(s.intent)}`);
  }

  console.log("\nVERIFICATION 6 — turn bounds");
  for (const t of turns) {
    console.log(
      `  ${t.turnId}  steps=${t.stepCount}  inProgress=${t.inProgress}  prompt=${JSON.stringify((t.prompt ?? "").slice(0, 46))}`,
    );
  }

  console.log("\nVERIFICATION 9 — toolResponseOf coverage");
  const resolved = all.filter((s) => s.status === "ok");
  const withOutput = resolved.filter((s) => s.output !== undefined && s.output.length > 0);
  console.log(`  resolved steps: ${resolved.length}   with output: ${withOutput.length}`);
}

void main();
