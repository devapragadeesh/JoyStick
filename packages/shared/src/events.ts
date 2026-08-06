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
 * One entry of PostToolBatch's `tool_calls`. Note the per-call result field is
 * `output`, not `tool_result` — PostToolBatch is the one event that names it
 * differently.
 */
export const BatchToolCallSchema = z
  .object({
    tool_name: z.string().optional(),
    tool_use_id: z.string().optional(),
    tool_input: z.unknown().optional(),
    output: z.unknown().optional(),
  })
  .passthrough();

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
