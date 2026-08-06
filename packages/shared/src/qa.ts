import { z } from "zod";

/**
 * Q&A providers, context assembly, and chat message shapes.
 *
 * Providers are user-configured, not a fixed built-in pair — three kinds,
 * one common interface the rest of the app talks to. `claude-cli` shells out
 * to the CLI (no key, metered, rate-limited server-side); `ollama` and
 * `openai-compatible` are the person's own — never contacted except when
 * that exact provider is the one explicitly chosen for a question.
 */

export const PROVIDER_KINDS = ["claude-cli", "ollama", "openai-compatible"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const OllamaConfigSchema = z.object({
  baseUrl: z.string().default("http://localhost:11434"),
  model: z.string().min(1),
});
export type OllamaConfig = z.infer<typeof OllamaConfigSchema>;

export const OpenAICompatibleConfigSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  /** Off by default. The user's own cost to manage; only they can opt in. */
  rateLimitPerHour: z.number().int().positive().optional(),
});
export type OpenAICompatibleConfig = z.infer<typeof OpenAICompatibleConfigSchema>;

export const ClaudeCliConfigSchema = z.object({}).strict();
export type ClaudeCliConfig = z.infer<typeof ClaudeCliConfigSchema>;

/** What the panel sees. `apiKey` is never present here — redacted at the API boundary. */
export interface ProviderSummary {
  id: string;
  kind: ProviderKind;
  label: string;
  isDefault: boolean;
  lastVerifiedAt: string | null;
  lastVerifiedOk: boolean | null;
  /** Config with any secret field stripped. Present so the settings UI can show baseUrl/model. */
  config: Record<string, unknown>;
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

export interface FileTimelineStepContext {
  sessionId: string;
  toolName: string | null;
  /** Verbatim from the transcript, or null. Never generated — same rule as Phase 1. */
  intent: string | null;
  status: string;
}

export interface FileContext {
  filePath: string;
  content: string;
  truncated: boolean;
  /** One hop only — files this file imports. */
  imports: string[];
  /** One hop only — files that import this file. */
  importedBy: string[];
  timelineSteps: FileTimelineStepContext[];
  /**
   * Always present, never omitted. Distinguishes "this file has touching
   * steps but none stated a reason" from "no step touched this file at all"
   * from "N steps found, M with a stated reason" — collapsing any of those
   * into silence would read as "nothing to find" when the honest state is
   * "here is exactly what was and wasn't checked."
   */
  timelineNote: string;
}

export interface AssembledContext {
  files: FileContext[];
}

export interface ChatMessage {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  /** Which provider answered. Null for user messages. Permanent, not a toast. */
  providerId: string | null;
  providerLabel: string | null;
  providerKind: ProviderKind | null;
  contextFiles: string[];
  createdAt: string;
}

export interface RateLimitStatus {
  limited: boolean;
  used: number;
  limit: number;
  resetsAt: string | null;
}

/** Truncate file content for context assembly, never silently. */
export const CONTEXT_FILE_SIZE_CAP = 8000;

export function truncateForContext(content: string, cap = CONTEXT_FILE_SIZE_CAP): { text: string; truncated: boolean } {
  if (content.length <= cap) return { text: content, truncated: false };
  return { text: content.slice(0, cap), truncated: true };
}
