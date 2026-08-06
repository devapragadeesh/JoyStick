/**
 * Measure intent coverage over transcript files.
 *
 * Deliberately runs the product's own extraction path — `parseEntries` and
 * `resolveIntent` — rather than a separate reimplementation, so the number
 * reported here is the number the panel would actually show. A bespoke
 * measurement script that agreed with nothing would be worse than no number.
 *
 *   pnpm coverage <transcript.jsonl | directory> [...]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEntries, resolveIntent } from "../packages/sidecar/src/transcript.js";

interface Row {
  file: string;
  toolUses: number;
  text: number;
  thinking: number;
}

function transcriptsIn(target: string): string[] {
  const st = statSync(target);
  if (!st.isDirectory()) return [target];
  return readdirSync(target)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(target, f));
}

function measure(file: string): Row {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const entries = parseEntries(lines, 0);
  const byUuid = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = byUuid.get(e.uuid) ?? [];
    list.push(e);
    byUuid.set(e.uuid, list);
  }

  const row: Row = { file, toolUses: 0, text: 0, thinking: 0 };
  for (const e of entries) {
    if (e.kind !== "tool_use") continue;
    row.toolUses++;
    const { source } = resolveIntent(e.parent_uuid, (uuid) => byUuid.get(uuid) ?? []);
    if (source === "text") row.text++;
    else if (source === "thinking") row.thinking++;
  }
  return row;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: pnpm coverage <transcript.jsonl | directory> [...]");
  process.exit(1);
}

const rows = targets
  .flatMap(transcriptsIn)
  .map(measure)
  .filter((r) => r.toolUses > 0)
  .sort((a, b) => b.toolUses - a.toolUses);

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((100 * n) / d));

console.log("  file                          tools   text  think  combined");
for (const r of rows) {
  const name = r.file.split("/").pop()!.slice(0, 28);
  console.log(
    `  ${name.padEnd(28)}  ${String(r.toolUses).padStart(5)}  ${String(pct(r.text, r.toolUses)).padStart(3)}%  ${String(pct(r.thinking, r.toolUses)).padStart(4)}%  ${String(pct(r.text + r.thinking, r.toolUses)).padStart(7)}%`,
  );
}

const t = rows.reduce(
  (a, r) => ({
    toolUses: a.toolUses + r.toolUses,
    text: a.text + r.text,
    thinking: a.thinking + r.thinking,
  }),
  { toolUses: 0, text: 0, thinking: 0 },
);
console.log(
  `\n  TOTAL ${rows.length} files            ${String(t.toolUses).padStart(5)}  ${String(pct(t.text, t.toolUses)).padStart(3)}%  ${String(pct(t.thinking, t.toolUses)).padStart(4)}%  ${String(pct(t.text + t.thinking, t.toolUses)).padStart(7)}%`,
);
