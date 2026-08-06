/**
 * Feed a saved JSONL of hook payloads into a running sidecar, so the panel can
 * be developed without a live Claude Code session.
 *
 *   pnpm replay                          # fixtures/sample-session.jsonl
 *   pnpm replay path/to/events.jsonl
 *   pnpm replay events.jsonl --speed 5   # 5x faster than recorded
 *   pnpm replay events.jsonl --fresh     # rewrite session ids so it lands as a new session
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));

/** Flags that take a value, so the value is not mistaken for the filename. */
const VALUED = new Set(["--speed", "--delay"]);

const positional = args.filter(
  (a, i) => !a.startsWith("--") && !(i > 0 && VALUED.has(args[i - 1])),
);

function flagValue(name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const file = resolve(positional[0] ?? "fixtures/sample-session.jsonl");
const port = process.env.JOYSTICK_PORT ?? "8787";
const url = `http://127.0.0.1:${port}/events`;
const speed = flagValue("--speed", 1);
const fresh = flags.has("--fresh");
const delay = flagValue("--delay", 120) / speed;

const lines = readFileSync(file, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

const sessionRemap = new Map<string, string>();

function remap(id: string): string {
  if (!fresh) return id;
  let next = sessionRemap.get(id);
  if (!next) {
    next = randomUUID();
    sessionRemap.set(id, next);
  }
  return next;
}

async function main(): Promise<void> {
  const health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`No sidecar on 127.0.0.1:${port}. Start it with \`pnpm dev\`.`);
    process.exit(1);
  }

  console.log(`replaying ${lines.length} events from ${file} → ${url}`);

  let sent = 0;
  for (const line of lines) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line);
    } catch {
      console.warn(`skipping unparseable line ${sent + 1}`);
      continue;
    }
    if (typeof payload.session_id === "string") {
      payload.session_id = remap(payload.session_id);
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status !== 204) {
      console.warn(`${payload.hook_event_name}: unexpected ${res.status}`);
    }
    sent++;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }

  console.log(`done: ${sent} events`);
}

void main();
