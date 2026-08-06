/**
 * Verification 5 evidence: show a step's position before and after the
 * transcript tailer catches up with it.
 */
import { buildTimeline, type EventRow, type ToolIntent } from "@joystick/shared";

const base = `http://127.0.0.1:${process.env.JOYSTICK_PORT ?? "8787"}`;
const sid = process.argv[2];

const events = (await (await fetch(`${base}/api/events?limit=2000&session_id=${sid}`)).json()) as EventRow[];
const intents = (await (await fetch(`${base}/api/intents?session_id=${sid}`)).json()) as ToolIntent[];
const roots = buildTimeline(events, intents).flatMap((t) => t.rootSteps);

console.log(`  intents known: ${intents.length}`);
for (const s of roots) {
  console.log(
    `    displayOrder=${String(s.displayOrder).padStart(13)}  provisional=${String(s.displayOrderProvisional).padEnd(5)}  intent=${s.intent === null ? "null" : JSON.stringify(s.intent.slice(0, 34))}  ${s.target}`,
  );
}
