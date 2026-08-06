import { z } from "zod";

/**
 * Hook event schemas, mirroring https://code.claude.com/docs/en/hooks as of
 * Claude Code 2.1.220.
 *
 * Two rules govern this file:
 *
 * 1. Everything beyond `hook_event_name` is optional. The docs describe the
 *    fields Claude Code *usually* sends; a schema that rejects a payload for a
 *    missing field would drop real history. Validation here decides how much we
 *    can index, never whether we keep the event.
 * 2. Nothing is stripped. `.passthrough()` preserves fields the docs have not
 *    documented yet, and the sidecar stores the raw bytes alongside the parsed
 *    form regardless.
 */

export const HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "PreCompact",
  "SessionEnd",
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export const PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;

/** Fields the docs list as common to every hook event. */
const commonFields = {
  session_id: z.string(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  prompt_id: z.string().optional(),
  permission_mode: z.enum(PERMISSION_MODES).optional(),
  effort: z.object({ level: z.string() }).passthrough().optional(),
  /** Present only when the event originated inside a subagent. */
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
};

const toolFields = {
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
};

/**
 * Where a tool's result actually lives.
 *
 * ⚠ The docs are wrong about this, for both events that carry a result.
 *
 *   | event          | docs say      | Claude Code 2.1.220 sends |
 *   | PostToolUse    | tool_result   | tool_response  (51/51)    |
 *   | PostToolBatch  | output        | tool_response  (51/51)    |
 *
 * Measured against every result-bearing payload captured during Phase 0
 * verification. Neither documented name appeared even once.
 *
 * The useful consequence is the opposite of what the docs imply: the two events
 * are *not* inconsistent with each other. They both use `tool_response`, so
 * transcript-join code can read one field for both.
 *
 * All three names are kept optional on the schema so a version that does emit a
 * documented name still parses, and `toolResponseOf` resolves whichever is
 * present. Read results through that helper, never by reaching for a field
 * directly — that is the mistake this comment exists to prevent.
 */
export const RESULT_FIELD_NAMES = ["tool_response", "output", "tool_result"] as const;

/** One entry of PostToolBatch's `tool_calls`. */
export interface BatchToolCall {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  /** Observed field. See RESULT_FIELD_NAMES. */
  tool_response?: unknown;
  /** Documented but never observed. Retained as a fallback only. */
  output?: unknown;
}

export const BatchToolCallSchema = z
  .object({
    tool_name: z.string().optional(),
    tool_use_id: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    output: z.unknown().optional(),
  })
  .passthrough();

/**
 * Resolve a tool result regardless of which field name carries it. Accepts a
 * PostToolUse payload or a single PostToolBatch tool_calls entry.
 */
export function toolResponseOf(source: unknown): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  const rec = source as Record<string, unknown>;
  for (const name of RESULT_FIELD_NAMES) {
    if (rec[name] !== undefined) return rec[name];
  }
  return undefined;
}

export const SessionStartSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("SessionStart"),
    source: z.enum(["startup", "resume", "clear", "compact", "fork"]).optional(),
  })
  .passthrough();

export const UserPromptSubmitSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("UserPromptSubmit"),
    prompt: z.string().optional(),
  })
  .passthrough();

export const PreToolUseSchema = z
  .object({
    ...commonFields,
    ...toolFields,
    hook_event_name: z.literal("PreToolUse"),
  })
  .passthrough();

export const PostToolUseSchema = z
  .object({
    ...commonFields,
    ...toolFields,
    hook_event_name: z.literal("PostToolUse"),
    // See RESULT_FIELD_NAMES: the observed field is tool_response, not the
    // documented tool_result. Both parse; read via toolResponseOf.
    tool_response: z.unknown().optional(),
    tool_result: z.unknown().optional(),
  })
  .passthrough();

export const PostToolUseFailureSchema = z
  .object({
    ...commonFields,
    ...toolFields,
    hook_event_name: z.literal("PostToolUseFailure"),
    tool_error: z.string().optional(),
  })
  .passthrough();

export const PostToolBatchSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("PostToolBatch"),
    tool_calls: z.array(BatchToolCallSchema).optional(),
  })
  .passthrough();

export const SubagentStartSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("SubagentStart"),
  })
  .passthrough();

export const SubagentStopSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("SubagentStop"),
    last_assistant_message: z.string().optional(),
  })
  .passthrough();

export const TaskCreatedSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("TaskCreated"),
    task_id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

export const TaskCompletedSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("TaskCompleted"),
    task_id: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough();

export const StopSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("Stop"),
    last_assistant_message: z.string().optional(),
  })
  .passthrough();

export const PreCompactSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("PreCompact"),
    trigger: z.enum(["manual", "auto"]).optional(),
  })
  .passthrough();

export const SessionEndSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("SessionEnd"),
    reason: z
      .enum([
        "clear",
        "resume",
        "logout",
        "prompt_input_exit",
        "bypass_permissions_disabled",
        "other",
      ])
      .optional(),
  })
  .passthrough();

export const HookEventSchema = z.discriminatedUnion("hook_event_name", [
  SessionStartSchema,
  UserPromptSubmitSchema,
  PreToolUseSchema,
  PostToolUseSchema,
  PostToolUseFailureSchema,
  PostToolBatchSchema,
  SubagentStartSchema,
  SubagentStopSchema,
  TaskCreatedSchema,
  TaskCompletedSchema,
  StopSchema,
  PreCompactSchema,
  SessionEndSchema,
]);

export type HookEvent = z.infer<typeof HookEventSchema>;

/**
 * The minimum we need to file an event at all: a session to attach it to and a
 * name to call it. Anything that clears this bar gets stored, even if the full
 * schema rejects it — see `classify`.
 */
export const EnvelopeSchema = z
  .object({
    session_id: z.string().min(1),
    hook_event_name: z.string().min(1),
  })
  .passthrough();

export type Envelope = z.infer<typeof EnvelopeSchema>;

export type Classified =
  | { kind: "known"; event: HookEvent; envelope: Envelope }
  | { kind: "unknown"; envelope: Envelope }
  | { kind: "rejected"; reason: string };

/**
 * Sort a payload into one of three buckets. `unknown` is not an error — it is
 * an event Claude Code sends that this version of joystick has not modelled,
 * and it is stored with full fidelity so a later version can backfill meaning
 * from the raw blob.
 */
export function classify(input: unknown): Classified {
  const envelope = EnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return { kind: "rejected", reason: envelope.error.issues[0]?.message ?? "invalid envelope" };
  }
  const known = HookEventSchema.safeParse(input);
  if (known.success) {
    return { kind: "known", event: known.data, envelope: envelope.data };
  }
  return { kind: "unknown", envelope: envelope.data };
}
