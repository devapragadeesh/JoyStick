import { useEffect, useRef, useState } from "react";
import type { BlastRadiusNote } from "@joystick/shared";

/**
 * Blast-radius notes for a session, keyed by the tool_use_id of the
 * Edit/Write that produced them.
 *
 * Same pattern as useSessionTimeline: backfill from REST on session change,
 * then a dedicated SSE subscription for live pushes so a note computed while
 * the panel is open appears immediately — including the pulse this drives in
 * CodeMap.tsx — without polling.
 */
export function useBlastRadius(sessionId: string | null): Map<string, BlastRadiusNote> {
  const [notes, setNotes] = useState<Map<string, BlastRadiusNote>>(new Map());
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    setNotes(new Map());
    if (!sessionId) return;

    let cancelled = false;

    const load = async () => {
      const res = await fetch(`/api/blast-radius?session_id=${encodeURIComponent(sessionId)}`);
      if (!res.ok || cancelled) return;
      const rows = (await res.json()) as BlastRadiusNote[];
      if (cancelled) return;
      setNotes(new Map(rows.map((r) => [r.toolUseId, r])));
    };
    void load();

    const source = new EventSource("/stream");
    source.addEventListener("blast-radius", (e) => {
      const note = JSON.parse((e as MessageEvent).data) as BlastRadiusNote;
      if (note.sessionId !== sessionRef.current) return;
      setNotes((prev) => new Map(prev).set(note.toolUseId, note));
    });

    return () => {
      cancelled = true;
      source.close();
    };
  }, [sessionId]);

  return notes;
}
