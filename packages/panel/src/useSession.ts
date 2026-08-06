import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildTimeline,
  type EventRow,
  type SessionSummary,
  type ToolIntent,
  type TurnGroup,
} from "@joystick/shared";

export type ConnectionStatus = "connecting" | "live" | "offline";

/**
 * One pipeline for both live and historical sessions.
 *
 * A live session and a replayed one differ only in whether new events keep
 * arriving — the fetch, the join, and the render are identical. That is what
 * makes replay parity a property of the design rather than something to test
 * for and hope holds.
 */
export function useSessions(): { sessions: SessionSummary[]; status: ConnectionStatus } {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) throw new Error(String(res.status));
        if (cancelled) return;
        setSessions((await res.json()) as SessionSummary[]);
        setStatus("live");
      } catch {
        if (!cancelled) setStatus("offline");
      }
    };

    void poll();
    // Session state is time-dependent: a "Live" session becomes "Likely ended"
    // purely by the clock advancing, with no new event to trigger a re-render.
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { sessions, status };
}

export interface SessionData {
  turns: TurnGroup[];
  events: EventRow[];
  stepCount: number;
  loading: boolean;
}

export function useSessionTimeline(sessionId: string | null): SessionData {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [intents, setIntents] = useState<ToolIntent[]>([]);
  const [loading, setLoading] = useState(false);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    seen.current = new Set();
    setEvents([]);
    setIntents([]);
    if (!sessionId) return;

    let cancelled = false;
    let source: EventSource | null = null;
    setLoading(true);

    const loadEvents = async () => {
      const res = await fetch(`/api/events?limit=2000&session_id=${encodeURIComponent(sessionId)}`);
      if (!res.ok || cancelled) return;
      const rows = (await res.json()) as EventRow[];
      for (const r of rows) seen.current.add(r.id);
      if (!cancelled) setEvents(rows);
    };

    /**
     * The transcript trails the live session, so intents are re-fetched on a
     * timer rather than once. A step renders from its hook payload immediately
     * and gains its intent and true position whenever the tailer catches up.
     */
    const loadIntents = async () => {
      const res = await fetch(`/api/intents?session_id=${encodeURIComponent(sessionId)}`);
      if (!res.ok || cancelled) return;
      if (!cancelled) setIntents((await res.json()) as ToolIntent[]);
    };

    void (async () => {
      await Promise.all([loadEvents(), loadIntents()]);
      if (!cancelled) setLoading(false);
    })();

    const intentTimer = setInterval(loadIntents, 2000);

    source = new EventSource("/stream");
    source.addEventListener("joystick", (e) => {
      const row = JSON.parse((e as MessageEvent).data) as EventRow;
      if (row.session_id !== sessionId || seen.current.has(row.id)) return;
      seen.current.add(row.id);
      setEvents((prev) => [...prev, row]);
    });

    return () => {
      cancelled = true;
      clearInterval(intentTimer);
      source?.close();
    };
  }, [sessionId]);

  const turns = useMemo(() => buildTimeline(events, intents), [events, intents]);
  const stepCount = useMemo(() => turns.reduce((n, t) => n + t.stepCount, 0), [turns]);

  return { turns, events, stepCount, loading };
}
