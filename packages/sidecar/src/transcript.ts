import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { IntentSource } from "@joystick/shared";
import type { Store } from "./db.js";

/**
 * Incremental transcript tailer.
 *
 * Reads each session's JSONL from a persisted byte offset rather than
 * re-reading from the start, and tolerates the file being mid-write: the
 * transcript is appended to asynchronously, so the last line is routinely a
 * partial JSON object. A partial trailing line is left unconsumed and picked up
 * on the next poll.
 *
 * Nothing here is on the ingest path. Events render from their hook payload
 * immediately; this only backfills intent and transcript position.
 */

interface TranscriptRecord {
  uuid?: string;
  parentUuid?: string | null;
  type?: string;
  message?: { content?: unknown };
  isSidechain?: boolean;
}

export interface ParsedEntry {
  uuid: string;
  parent_uuid: string | null;
  line_index: number;
  kind: "text" | "thinking" | "tool_use" | "other";
  tool_use_id: string | null;
  tool_name: string | null;
  text: string | null;
}

/**
 * Read whole lines starting at `offset`.
 *
 * Returns the lines that were complete, and the offset just past the last
 * newline. Bytes after that — a half-written record — stay unread.
 */
export function readCompleteLines(
  path: string,
  offset: number,
): { lines: string[]; nextOffset: number; reset: boolean } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { lines: [], nextOffset: offset, reset: false };
  }

  // The file shrank: it was truncated or replaced. Start over rather than
  // reading from a stale offset into the middle of a record.
  const reset = size < offset;
  const from = reset ? 0 : offset;
  if (size <= from) return { lines: [], nextOffset: from, reset };

  const length = size - from;
  const buffer = Buffer.allocUnsafe(length);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, from);
  } catch {
    return { lines: [], nextOffset: offset, reset: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    // No complete line in this chunk yet.
    return { lines: [], nextOffset: from, reset };
  }

  const complete = buffer.subarray(0, lastNewline + 1).toString("utf8");
  return {
    lines: complete.split("\n").filter((l) => l.length > 0),
    nextOffset: from + lastNewline + 1,
    reset,
  };
}

/** Turn raw JSONL lines into the entries the join needs. Unparseable lines are skipped. */
export function parseEntries(lines: string[], startIndex: number): ParsedEntry[] {
  const entries: ParsedEntry[] = [];

  lines.forEach((line, i) => {
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      // A record that failed to parse despite ending in a newline is corrupt,
      // not merely incomplete. Skipping it keeps the tailer moving.
      return;
    }
    if (record.type !== "assistant" || !record.uuid) return;

    const content = record.message?.content;
    if (!Array.isArray(content)) return;

    const lineIndex = startIndex + i;

    // Claude Code writes each content block as its own record — a text block
    // and a tool_use block never share a message (0 of 180 in a large captured
    // session). The loop below is written to survive that changing.
    for (const blockValue of content) {
      const block = blockValue as Record<string, unknown>;
      const type = block.type;

      if (type === "tool_use" && typeof block.id === "string") {
        entries.push({
          uuid: record.uuid,
          parent_uuid: record.parentUuid ?? null,
          line_index: lineIndex,
          kind: "tool_use",
          tool_use_id: block.id,
          tool_name: typeof block.name === "string" ? block.name : null,
          text: null,
        });
      } else if (type === "text" && typeof block.text === "string") {
        entries.push({
          uuid: record.uuid,
          parent_uuid: record.parentUuid ?? null,
          line_index: lineIndex,
          kind: "text",
          tool_use_id: null,
          tool_name: null,
          text: block.text,
        });
      } else if (type === "thinking" && typeof block.thinking === "string") {
        entries.push({
          uuid: record.uuid,
          parent_uuid: record.parentUuid ?? null,
          line_index: lineIndex,
          kind: "thinking",
          tool_use_id: null,
          tool_name: null,
          text: block.thinking,
        });
      }
    }
  });

  return entries;
}

/**
 * Resolve the intent for a tool_use by walking back to its parent record.
 *
 * "The text immediately preceding the tool call" cannot mean the preceding
 * block within a message, because blocks never share a message. It means the
 * preceding assistant *record*, reached through parentUuid.
 *
 * Text is preferred over thinking when both are present so the more deliberate
 * statement wins; the source is recorded either way so the UI can distinguish
 * them. Both are verbatim transcript content — nothing here generates text.
 */
export function resolveIntent(
  parentUuid: string | null,
  lookup: (uuid: string) => ParsedEntry[],
): { intent: string | null; source: IntentSource | null } {
  if (!parentUuid) return { intent: null, source: null };

  const siblings = lookup(parentUuid);
  const text = siblings.find((e) => e.kind === "text" && e.text);
  if (text?.text) return { intent: text.text, source: "text" };

  const thinking = siblings.find((e) => e.kind === "thinking" && e.text);
  if (thinking?.text) return { intent: thinking.text, source: "thinking" };

  return { intent: null, source: null };
}

export interface TailResult {
  transcript_path: string;
  linesRead: number;
  intentsWritten: number;
  reset: boolean;
}

/** Poll every known transcript once. Never throws; a bad file is skipped. */
export function tailOnce(store: Store): TailResult[] {
  const results: TailResult[] = [];

  for (const target of store.transcriptTargets()) {
    try {
      results.push(tailOne(store, target.session_id, target.transcript_path));
    } catch {
      // A transcript that cannot be read is not a reason to stop tailing the
      // others, and never a reason to disturb the session.
    }
  }

  return results;
}

function tailOne(store: Store, sessionId: string, path: string): TailResult {
  const state = store.transcriptOffset(path);
  const { lines, nextOffset, reset } = readCompleteLines(path, state.byte_offset);

  if (reset) store.clearTranscript(path);
  if (lines.length === 0) {
    if (reset) store.setTranscriptOffset(path, sessionId, nextOffset, 0);
    return { transcript_path: path, linesRead: 0, intentsWritten: 0, reset };
  }

  const startIndex = reset ? 0 : state.line_index;
  const entries = parseEntries(lines, startIndex);
  store.insertTranscriptEntries(path, sessionId, entries);

  // Resolve intents for the tool_use records just read. Parents can live in an
  // earlier chunk, so the lookup goes through the database rather than memory.
  let intentsWritten = 0;
  for (const entry of entries) {
    if (entry.kind !== "tool_use" || !entry.tool_use_id) continue;
    const { intent, source } = resolveIntent(entry.parent_uuid, (uuid) =>
      store.transcriptEntriesByUuid(path, uuid),
    );
    store.upsertToolIntent({
      session_id: sessionId,
      tool_use_id: entry.tool_use_id,
      transcript_pos: entry.line_index,
      intent,
      intent_source: source,
    });
    intentsWritten++;
  }

  store.setTranscriptOffset(path, sessionId, nextOffset, startIndex + lines.length);
  return { transcript_path: path, linesRead: lines.length, intentsWritten, reset };
}

/** Background poller. Unref'd so it never keeps the process alive on its own. */
export function startTailer(store: Store, intervalMs = 500): { stop: () => void } {
  const timer = setInterval(() => {
    try {
      tailOnce(store);
    } catch {
      /* never let the tailer take the server down */
    }
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
