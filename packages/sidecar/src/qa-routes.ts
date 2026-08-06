import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  ClaudeCliConfigSchema,
  OllamaConfigSchema,
  OpenAICompatibleConfigSchema,
  PROVIDER_KINDS,
  type ChatMessage,
  type ProviderKind,
  type ProviderSummary,
} from "@joystick/shared";
import type { ProviderRow, Store } from "./db.js";
import { verifyProvider } from "./providers.js";
import { assembleContext } from "./qa-context.js";
import { askClaudeCli, askOllama, askOpenAICompatible, buildPromptText } from "./qa-backends.js";
import { config } from "./config.js";

/**
 * Q&A routes: provider CRUD (with B.4.1's save-time connectivity check),
 * chat, and the claude-cli rate-limit guardrail (B.5).
 *
 * Kept out of server.ts, same reasoning as CodeGraphScheduler living in its
 * own file: this is a self-contained feature with enough surface area of its
 * own to be worth not inlining into the already-large route table.
 */

function configSchemaFor(kind: ProviderKind) {
  switch (kind) {
    case "ollama":
      return OllamaConfigSchema;
    case "openai-compatible":
      return OpenAICompatibleConfigSchema;
    case "claude-cli":
      return ClaudeCliConfigSchema;
  }
}

/** What the panel sees — `apiKey` (the only secret any config carries) stripped. */
function toProviderSummary(row: ProviderRow): ProviderSummary {
  const parsed = JSON.parse(row.config) as Record<string, unknown>;
  delete parsed.apiKey;
  return {
    id: row.id,
    kind: row.kind as ProviderKind,
    label: row.label,
    isDefault: row.is_default === 1,
    lastVerifiedAt: row.last_verified_at,
    lastVerifiedOk: row.last_verified_ok === null ? null : row.last_verified_ok === 1,
    config: parsed,
  };
}

function toChatMessage(row: {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  text: string;
  provider_id: string | null;
  provider_label: string | null;
  provider_kind: string | null;
  context_files: string;
  created_at: string;
}): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    text: row.text,
    providerId: row.provider_id,
    providerLabel: row.provider_label,
    providerKind: row.provider_kind as ProviderKind | null,
    contextFiles: JSON.parse(row.context_files) as string[],
    createdAt: row.created_at,
  };
}

async function dispatchToProvider(
  row: ProviderRow,
  promptText: string,
): Promise<{ text: string }> {
  const config_ = JSON.parse(row.config) as Record<string, unknown>;
  switch (row.kind as ProviderKind) {
    case "claude-cli":
      return askClaudeCli(promptText);
    case "ollama":
      return askOllama(config_ as never, promptText);
    case "openai-compatible":
      return askOpenAICompatible(config_ as never, promptText);
    default:
      throw new Error(`unknown provider kind: ${row.kind}`);
  }
}

export function registerQaRoutes(app: FastifyInstance, store: Store): void {
  app.get("/api/qa/providers", async () => store.providers().map(toProviderSummary));

  /** Add a provider. Verifies before saving (B.4.1) — a bad config never gets stored. */
  app.post("/api/qa/providers", async (request, reply) => {
    const body = request.body as { kind?: string; label?: string; config?: unknown; isDefault?: boolean };
    if (!body.kind || !PROVIDER_KINDS.includes(body.kind as ProviderKind)) {
      return reply.code(400).send({ ok: false, detail: `kind must be one of ${PROVIDER_KINDS.join(", ")}` });
    }
    const kind = body.kind as ProviderKind;
    const schema = configSchemaFor(kind);
    const parsed = schema.safeParse(body.config ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, detail: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const label = typeof body.label === "string" && body.label.length > 0 ? body.label : kind;

    const verify = await verifyProvider(kind, parsed.data as never);
    if (!verify.ok) {
      // Caught here, not discovered later: nothing is written to the store.
      return reply.code(422).send({ ok: false, detail: verify.detail });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    store.upsertProvider({
      id,
      kind,
      label,
      config: parsed.data,
      isDefault: body.isDefault === true,
      lastVerifiedAt: now,
      lastVerifiedOk: true,
      createdAt: now,
    });
    return { ok: true, detail: verify.detail, provider: toProviderSummary(store.provider(id)!) };
  });

  /** Edit a provider's label/config. Same save-time verification as create. */
  app.put("/api/qa/providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = store.provider(id);
    if (!existing) return reply.code(404).send({ ok: false, detail: "provider not found" });

    const body = request.body as { label?: string; config?: unknown; isDefault?: boolean };
    const kind = existing.kind as ProviderKind;
    const schema = configSchemaFor(kind);
    const parsed = schema.safeParse(body.config ?? JSON.parse(existing.config));
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, detail: parsed.error.issues.map((i) => i.message).join("; ") });
    }

    const verify = await verifyProvider(kind, parsed.data as never);
    if (!verify.ok) {
      return reply.code(422).send({ ok: false, detail: verify.detail });
    }

    const now = new Date().toISOString();
    store.upsertProvider({
      id,
      kind,
      label: body.label ?? existing.label,
      config: parsed.data,
      isDefault: body.isDefault ?? existing.is_default === 1,
      lastVerifiedAt: now,
      lastVerifiedOk: true,
      createdAt: existing.created_at,
    });
    return { ok: true, detail: verify.detail, provider: toProviderSummary(store.provider(id)!) };
  });

  /** Re-run the connectivity check for an existing provider without editing it. */
  app.post("/api/qa/providers/:id/test", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = store.provider(id);
    if (!row) return reply.code(404).send({ ok: false, detail: "provider not found" });
    const result = await verifyProvider(row.kind as ProviderKind, JSON.parse(row.config));
    store.setProviderVerification(id, result.ok, new Date().toISOString());
    return result;
  });

  app.post("/api/qa/providers/:id/default", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.provider(id)) return reply.code(404).send({ ok: false, detail: "provider not found" });
    store.setDefaultProvider(id);
    return { ok: true };
  });

  app.delete("/api/qa/providers/:id", async (request) => {
    const { id } = request.params as { id: string };
    store.deleteProvider(id);
    return { ok: true };
  });

  app.get("/api/qa/messages", async (request) => {
    const q = request.query as { session_id?: string };
    return q.session_id ? store.chatMessages(q.session_id).map(toChatMessage) : [];
  });

  /**
   * Ask a question. Context is assembled once and sent only to the provider
   * explicitly chosen for this call — never a silent fallback to another
   * (B.6). claude-cli is the only kind subject to the rolling-hour limit.
   */
  app.post("/api/qa/chat", async (request, reply) => {
    const body = request.body as { sessionId?: string; providerId?: string; question?: string; filePaths?: string[] };
    if (!body.sessionId || !body.providerId || !body.question) {
      return reply.code(400).send({ ok: false, detail: "sessionId, providerId, and question are required" });
    }
    const provider = store.provider(body.providerId);
    if (!provider) return reply.code(404).send({ ok: false, detail: "provider not found" });

    const filePaths = body.filePaths ?? [];
    const now = Date.now();

    if (provider.kind === "claude-cli") {
      const used = store.claudeCliCallsInWindow(now, config.claudeCliRateLimitWindowMs);
      if (used >= config.claudeCliRateLimitPerHour) {
        const oldest = store.oldestClaudeCliCallInWindow(now, config.claudeCliRateLimitWindowMs);
        const resetsAt = oldest !== null ? new Date(oldest + config.claudeCliRateLimitWindowMs).toISOString() : null;
        return reply.code(429).send({
          ok: false,
          detail: `claude-cli rate limit reached: ${used}/${config.claudeCliRateLimitPerHour} calls used this hour.${
            resetsAt ? ` Resets at ${resetsAt}.` : ""
          }`,
          limited: true,
          used,
          limit: config.claudeCliRateLimitPerHour,
          resetsAt,
        });
      }
    }

    const nowIso = new Date().toISOString();
    store.insertChatMessage({
      sessionId: body.sessionId,
      role: "user",
      text: body.question,
      providerId: null,
      providerLabel: null,
      providerKind: null,
      contextFiles: filePaths,
      createdAt: nowIso,
    });

    const context = await assembleContext(store, body.sessionId, filePaths);
    const promptText = buildPromptText(body.question, context);

    if (provider.kind === "claude-cli") store.recordClaudeCliCall(now);

    let answerText: string;
    try {
      const answer = await dispatchToProvider(provider, promptText);
      answerText = answer.text;
    } catch (err) {
      return reply.code(502).send({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    }

    const answerId = store.insertChatMessage({
      sessionId: body.sessionId,
      role: "assistant",
      text: answerText,
      providerId: provider.id,
      providerLabel: provider.label,
      providerKind: provider.kind as ProviderKind,
      contextFiles: filePaths,
      createdAt: new Date().toISOString(),
    });

    return toChatMessage({ ...store.chatMessages(body.sessionId).find((m) => m.id === answerId)! });
  });
}
