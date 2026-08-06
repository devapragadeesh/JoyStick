import { SESSION_STATE_LABEL, sessionState, type SessionSummary } from "@joystick/shared";

/**
 * The three states are visually distinct on purpose. Phase 0 established that a
 * crashed session and a cleanly-exited one are genuinely different and both
 * knowable — showing them identically would discard that.
 */
export function SessionPicker({
  sessions,
  selected,
  onSelect,
  now,
}: {
  sessions: SessionSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
  now: number;
}) {
  return (
    <nav className="picker">
      <h2>Sessions</h2>
      {sessions.length === 0 && <p className="muted">None recorded yet.</p>}
      <ul>
        {sessions.map((s) => {
          const state = sessionState(s, now);
          return (
            <li key={s.session_id}>
              <button
                className={`session ${selected === s.session_id ? "session-selected" : ""}`}
                onClick={() => onSelect(s.session_id)}
              >
                <span className="session-title">
                  {s.title ?? <span className="muted">(no prompt)</span>}
                </span>
                <span className={`badge badge-${state}`}>{SESSION_STATE_LABEL[state]}</span>
                <span className="session-meta">
                  {s.cwd ? basename(s.cwd) : "—"} · {new Date(s.started_at).toLocaleTimeString(
                    undefined,
                    { hour12: false, hour: "2-digit", minute: "2-digit" },
                  )}
                </span>
                <span className="session-meta">
                  {s.event_count} events · {s.files_touched} file
                  {s.files_touched === 1 ? "" : "s"} touched
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.at(-1) ?? p;
}
