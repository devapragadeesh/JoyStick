import type { OllamaConfig, OpenAICompatibleConfig, ProviderKind, VerifyResult } from "@joystick/shared";

/**
 * Connectivity checks, one per provider kind (B.4.1).
 *
 * Run before a provider is ever saved, so a bad baseUrl or key is caught with
 * a clear message at save time rather than surfacing later as a mysterious
 * chat failure. Each check is a minimal, cheap call — a models/tags listing,
 * never a real completion — with a short timeout so a dead endpoint fails
 * fast instead of hanging the save.
 */

const VERIFY_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function verifyOllama(config: OllamaConfig): Promise<VerifyResult> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/api/tags`;
  try {
    const res = await fetchWithTimeout(url, { method: "GET" });
    if (!res.ok) return { ok: false, detail: `${url} responded ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const names = (body.models ?? []).map((m) => m.name).filter((n): n is string => !!n);
    if (config.model && !names.includes(config.model)) {
      return {
        ok: false,
        detail: `Ollama is reachable at ${config.baseUrl}, but model "${config.model}" is not pulled. Available: ${names.join(", ") || "none"}`,
      };
    }
    return { ok: true, detail: `Ollama reachable at ${config.baseUrl}, model "${config.model}" available` };
  } catch (err) {
    return { ok: false, detail: `Could not reach ${url}: ${errMessage(err)}` };
  }
}

async function verifyOpenAICompatible(config: OpenAICompatibleConfig): Promise<VerifyResult> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/models`;
  try {
    const res = await fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) {
      const detail =
        res.status === 401 || res.status === 403
          ? `${url} rejected the API key (${res.status})`
          : `${url} responded ${res.status}`;
      return { ok: false, detail };
    }
    return { ok: true, detail: `${config.baseUrl} reachable, API key accepted` };
  } catch (err) {
    return { ok: false, detail: `Could not reach ${url}: ${errMessage(err)}` };
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function verifyProvider(
  kind: ProviderKind,
  config: OllamaConfig | OpenAICompatibleConfig | Record<string, never>,
): Promise<VerifyResult> {
  switch (kind) {
    case "claude-cli":
      // No key, no network endpoint to reach — the CLI binary itself is the
      // only failure mode, and that surfaces per-call rather than at save time.
      return { ok: true, detail: "claude-cli needs no connectivity check" };
    case "ollama":
      return verifyOllama(config as OllamaConfig);
    case "openai-compatible":
      return verifyOpenAICompatible(config as OpenAICompatibleConfig);
  }
}
