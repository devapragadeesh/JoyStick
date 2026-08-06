import type { Envelope } from "./events.js";

/**
 * Structural one-line summaries. Every string here is derived from fields the
 * payload already contains — no model is consulted, in this phase or any later
 * one. Narration in Phase 1 comes from re-rendering Claude's own reasoning out
 * of the transcript, not from generating new text.
 */

const MAX = 120;

function clip(s: string, max = MAX): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length > 1 ? `${parts.at(-2)}/${parts.at(-1)}` : (parts.at(-1) ?? p);
}

/** A short label for what a tool call is about to do, or just did. */
export function describeToolCall(toolName: string | undefined, toolInput: unknown): string {
  const name = toolName ?? "tool";
  const input = (toolInput ?? {}) as Record<string, unknown>;

  // Pattern comes first: for Grep and Glob, `path` is only the search root, so
  // leading with it would hide the thing actually being looked for.
  const pattern = str(input.pattern);
  if (pattern) {
    // Grep patterns are regexes and read better delimited; globs are not.
    const shown = name === "Grep" ? `/${clip(pattern, 40)}/` : clip(pattern, 40);
    const where = str(input.path);
    return where ? `${name} ${shown} in ${basename(where)}` : `${name} ${shown}`;
  }

  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  if (path) return `${name} ${basename(path)}`;

  const command = str(input.command);
  if (command) return `${name} ${clip(command, 80)}`;

  const url = str(input.url);
  if (url) return `${name} ${clip(url, 80)}`;

  const prompt = str(input.prompt) ?? str(input.description);
  if (prompt) return `${name} ${clip(prompt, 80)}`;

  const skill = str(input.skill);
  if (skill) return `${name} ${skill}`;

  return name;
}

/** The single line the panel shows for an event. */
export function summarize(payload: Envelope): string {
  const p = payload as Record<string, unknown>;
  const tool = str(p.tool_name);

  switch (payload.hook_event_name) {
    case "SessionStart":
      return `session started (${str(p.source) ?? "startup"})`;

    case "SessionEnd":
      return `session ended (${str(p.reason) ?? "other"})`;

    case "UserPromptSubmit":
      return clip(str(p.prompt) ?? "(empty prompt)");

    case "PreToolUse":
      return describeToolCall(tool, p.tool_input);

    case "PostToolUse":
      return describeToolCall(tool, p.tool_input);

    case "PostToolUseFailure":
      return `${describeToolCall(tool, p.tool_input)} — ${clip(str(p.tool_error) ?? "failed", 60)}`;

    case "PostToolBatch": {
      const calls = Array.isArray(p.tool_calls) ? p.tool_calls : [];
      if (calls.length === 0) return "batch resolved";
      const names = calls
        .map((c) => str((c as Record<string, unknown>).tool_name) ?? "tool")
        .join(", ");
      return `batch of ${calls.length}: ${clip(names, 90)}`;
    }

    case "SubagentStart":
      return `subagent started: ${str(p.agent_type) ?? "unknown"}`;

    case "SubagentStop":
      return `subagent finished: ${str(p.agent_type) ?? "unknown"}`;

    case "TaskCreated":
      return `task created: ${clip(str(p.title) ?? str(p.task_id) ?? "untitled", 90)}`;

    case "TaskCompleted":
      return `task completed: ${clip(str(p.title) ?? str(p.task_id) ?? "untitled", 90)}`;

    case "Stop":
      return clip(str(p.last_assistant_message) ?? "turn ended");

    case "PreCompact":
      return `compacting (${str(p.trigger) ?? "auto"})`;

    default:
      return payload.hook_event_name;
  }
}
