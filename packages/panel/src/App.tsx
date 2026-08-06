import { useMemo, useState } from "react";
import type { EventRow } from "@joystick/shared";
import { useEventStream } from "./useEventStream.js";

/**
 * Phase 0 panel: a reverse-chronological list of everything that happened.
 *
 * Every value below arrives from a hook payload and is therefore untrusted. It
 * reaches the DOM only as a React text child, never as HTML.
 */
export function App() {
  const { events, status } = useEventStream();
  const [session, setSession] = useState<string>("all");

  const sessions = useMemo(() => {
    const ids = new Set(events.map((e) => e.session_id));
    return [...ids];
  }, [events]);

  const visible = useMemo(
    () => (session === "all" ? events : events.filter((e) => e.session_id === session)),
    [events, session],
  );

  return (
    <div className="app">
      <header>
        <h1>joystick</h1>
        <span className={`status status-${status}`}>{status}</span>
        <span className="count">{visible.length} events</span>
        {sessions.length > 1 && (
          <select value={session} onChange={(e) => setSession(e.target.value)}>
            <option value="all">all sessions</option>
            {sessions.map((id) => (
              <option key={id} value={id}>
                {id.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
      </header>

      {visible.length === 0 && (
        <p className="empty">
          {status === "offline"
            ? "Sidecar unreachable. Retrying."
            : "Waiting for events. Run a Claude Code session, or `pnpm replay`."}
        </p>
      )}

      <ol className="events">
        {visible.map((e) => (
          <EventItem key={e.id} event={e} />
        ))}
      </ol>
    </div>
  );
}

function EventItem({ event }: { event: EventRow }) {
  const [open, setOpen] = useState(false);
  const time = new Date(event.received_at).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <li className={`event event-${kind(event.hook_event_name)}`}>
      <button className="row" onClick={() => setOpen((o) => !o)}>
        <span className="time">{time}</span>
        <span className="seq">#{event.seq}</span>
        <span className="name">{event.hook_event_name}</span>
        {event.agent_type && <span className="agent">{event.agent_type}</span>}
        <span className="summary">{event.summary}</span>
      </button>
      {open && <pre className="raw">{JSON.stringify(event.raw, null, 2)}</pre>}
    </li>
  );
}

function kind(name: string): string {
  if (name.startsWith("Subagent")) return "agent";
  if (name.endsWith("Failure")) return "fail";
  if (name.startsWith("Session")) return "session";
  if (name.startsWith("Task")) return "task";
  if (name === "UserPromptSubmit" || name === "Stop") return "turn";
  return "tool";
}
