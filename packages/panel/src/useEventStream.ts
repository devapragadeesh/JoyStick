import { useEffect, useRef, useState } from "react";
import type { EventRow } from "@joystick/shared";

export type Status = "connecting" | "live" | "offline";

const MAX_EVENTS = 2000;

/**
 * Backfill from /api/events, then follow /stream.
 *
 * The sidecar going away is an ordinary condition, not an error: the panel drops
 * to "offline" and keeps retrying quietly, and reconnecting re-backfills so any
 * events broadcast while we were gone still appear.
 */
export function useEventStream(): { events: EventRow[]; status: Status } {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const seen = useRef(new Set<number>());

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const add = (incoming: EventRow[]) => {
      setEvents((prev) => {
        const fresh = incoming.filter((e) => !seen.current.has(e.id));
        if (fresh.length === 0) return prev;
        for (const e of fresh) seen.current.add(e.id);
        // Newest first.
        return [...fresh, ...prev].sort((a, b) => b.id - a.id).slice(0, MAX_EVENTS);
      });
    };

    const connect = async () => {
      if (cancelled) return;
      try {
        const res = await fetch("/api/events?limit=500");
        if (!res.ok) throw new Error(String(res.status));
        add((await res.json()) as EventRow[]);
      } catch {
        if (cancelled) return;
        setStatus("offline");
        retry = setTimeout(connect, 2000);
        return;
      }

      if (cancelled) return;
      source = new EventSource("/stream");
      source.onopen = () => setStatus("live");
      source.addEventListener("joystick", (e) => {
        add([JSON.parse((e as MessageEvent).data) as EventRow]);
      });
      source.onerror = () => {
        setStatus("offline");
        source?.close();
        source = null;
        if (!cancelled) retry = setTimeout(connect, 2000);
      };
    };

    void connect();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, []);

  return { events, status };
}
