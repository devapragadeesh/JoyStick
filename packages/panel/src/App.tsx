import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Timeline } from "./Timeline.js";
import { SessionPicker } from "./SessionPicker.js";
import { CodeMap } from "./CodeMap.js";
import { useSessions, useSessionTimeline } from "./useSession.js";

type Tab = "timeline" | "codemap";

export function App() {
  const { sessions, status } = useSessions();
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState<Tab>("timeline");

  // Session state depends on elapsed time, not only on new events, so the clock
  // has to advance independently of the data.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  // Default to the most recent session once one exists.
  useEffect(() => {
    if (selected === null && sessions.length > 0) setSelected(sessions[0].session_id);
  }, [sessions, selected]);

  const { turns, stepCount, loading } = useSessionTimeline(selected);
  const { scrollRef, pendingCount, atLive, jumpToLive } = useLiveScroll(stepCount);

  return (
    <div className="app">
      <header>
        <h1>joystick</h1>
        <span className={`status status-${status}`}>{status}</span>
        <nav className="tabs">
          <button className={tab === "timeline" ? "tab tab-active" : "tab"} onClick={() => setTab("timeline")}>
            Timeline
          </button>
          <button className={tab === "codemap" ? "tab tab-active" : "tab"} onClick={() => setTab("codemap")}>
            Import graph
          </button>
        </nav>
        {tab === "timeline" && <span className="muted">{stepCount} steps</span>}
      </header>

      {tab === "timeline" && (
        <div className="layout">
          <SessionPicker
            sessions={sessions}
            selected={selected}
            onSelect={setSelected}
            now={now}
          />

          <main ref={scrollRef}>
            {loading && <p className="muted">Loading…</p>}
            {!loading && selected === null && <p className="empty">Select a session.</p>}
            {!loading && selected !== null && <Timeline turns={turns} />}
          </main>
        </div>
      )}

      {tab === "codemap" && <CodeMap />}

      {tab === "timeline" && !atLive && pendingCount > 0 && (
        <button className="jump" onClick={jumpToLive}>
          {pendingCount} new step{pendingCount === 1 ? "" : "s"} · jump to live
        </button>
      )}
    </div>
  );
}

/**
 * Auto-scroll that yields to the user.
 *
 * Following the newest step is only helpful while the user is watching the
 * newest step. The moment they scroll up to read something, continuing to yank
 * the viewport would make the panel unusable — so auto-scroll switches off and
 * new steps are announced instead.
 */
function useLiveScroll(stepCount: number) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const [atLive, setAtLive] = useState(true);
  const [seenCount, setSeenCount] = useState(stepCount);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromTop = el.scrollTop;
      // Newest turn renders first, so "live" is the top of the list.
      setAtLive(distanceFromTop < 40);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (atLive) {
      scrollRef.current?.scrollTo({ top: 0 });
      setSeenCount(stepCount);
    }
  }, [stepCount, atLive]);

  const jumpToLive = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setAtLive(true);
    setSeenCount(stepCount);
  };

  return {
    scrollRef,
    atLive,
    pendingCount: Math.max(0, stepCount - seenCount),
    jumpToLive,
  };
}
