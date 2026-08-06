import { useCallback, useEffect, useState } from "react";
import type { ChatMessage, ProviderKind, ProviderSummary, VerifyResult } from "@joystick/shared";

/**
 * Provider list + CRUD, and per-session chat history + send.
 *
 * Mirrors useSession.ts's fetch-and-poll pattern rather than inventing a
 * second one: providers are polled (another browser tab's settings edit
 * should show up here too), messages are refetched after every send since
 * chat volume is low enough that polling on a timer would be pure overhead.
 */

export function useProviders() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/qa/providers");
    if (!res.ok) return;
    setProviders((await res.json()) as ProviderSummary[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const addProvider = useCallback(
    async (input: { kind: ProviderKind; label: string; config: unknown }): Promise<{ ok: boolean; detail: string }> => {
      const res = await fetch("/api/qa/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await res.json()) as { ok: boolean; detail: string };
      if (body.ok) await refresh();
      return body;
    },
    [refresh],
  );

  const testProvider = useCallback(
    async (id: string): Promise<VerifyResult> => {
      const res = await fetch(`/api/qa/providers/${id}/test`, { method: "POST" });
      const result = (await res.json()) as VerifyResult;
      await refresh();
      return result;
    },
    [refresh],
  );

  const deleteProvider = useCallback(
    async (id: string) => {
      await fetch(`/api/qa/providers/${id}`, { method: "DELETE" });
      await refresh();
    },
    [refresh],
  );

  return { providers, loading, addProvider, testProvider, deleteProvider };
}

export interface SendResult {
  ok: boolean;
  detail?: string;
}

export function useChat(sessionId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    const res = await fetch(`/api/qa/messages?session_id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    setMessages((await res.json()) as ChatMessage[]);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const send = useCallback(
    async (providerId: string, question: string, filePaths: string[]): Promise<SendResult> => {
      if (!sessionId) return { ok: false, detail: "no session selected" };
      setSending(true);
      try {
        const res = await fetch("/api/qa/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, providerId, question, filePaths }),
        });
        const body = (await res.json()) as { detail?: string };
        await refresh();
        return { ok: res.ok, detail: body.detail };
      } finally {
        setSending(false);
      }
    },
    [sessionId, refresh],
  );

  return { messages, sending, send };
}
