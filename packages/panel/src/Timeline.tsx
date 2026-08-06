import { useState } from "react";
import type { BlastRadiusNote, TimelineStep, TurnGroup } from "@joystick/shared";
import { ExploredSummary, isExploratory, Step } from "./Step.js";

/**
 * Turn grouping and nesting.
 *
 * Turns run UserPromptSubmit → Stop. A turn with no Stop is not an error state:
 * Phase 0 confirmed a killed session simply stops emitting, so an open turn is
 * rendered as in progress rather than withheld.
 */
export function Timeline({
  turns,
  blastRadius,
}: {
  turns: TurnGroup[];
  blastRadius?: Map<string, BlastRadiusNote>;
}) {
  if (turns.length === 0) {
    return <p className="empty">No steps yet for this session.</p>;
  }

  // Newest turn first, expanded; older turns collapse to a single line.
  const ordered = [...turns].reverse();

  return (
    <div className="timeline">
      {ordered.map((turn, i) => (
        <Turn key={turn.turnId} turn={turn} defaultOpen={i === 0} blastRadius={blastRadius} />
      ))}
    </div>
  );
}

function Turn({
  turn,
  defaultOpen,
  blastRadius,
}: {
  turn: TurnGroup;
  defaultOpen: boolean;
  blastRadius?: Map<string, BlastRadiusNote>;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={`turn ${turn.inProgress ? "turn-active" : ""}`}>
      <button className="turn-head" onClick={() => setOpen((o) => !o)}>
        <span className="turn-caret">{open ? "▾" : "▸"}</span>
        <span className="turn-prompt">{turn.prompt ?? "(no prompt recorded)"}</span>
        <span className="turn-meta">
          {turn.stepCount} step{turn.stepCount === 1 ? "" : "s"}
          {turn.durationMs !== null && ` · ${formatDuration(turn.durationMs)}`}
          {turn.inProgress && " · in progress"}
        </span>
      </button>

      {open && (
        <>
          <ol className="steps">{renderSteps(turn.rootSteps, turn, blastRadius)}</ol>

          {turn.unattributedSteps.length > 0 && (
            <div className="unattributed">
              <h3>
                unattributed subagent steps
                <span className="muted">
                  {" "}
                  · parent could not be determined
                </span>
              </h3>
              <ol className="steps">
                {turn.unattributedSteps.map((s) => (
                  <Step key={s.id} step={s} depth={1} blastRadius={blastRadius?.get(s.id)} />
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Fold consecutive successful Read/Grep/Glob calls into one line. They are kept
 * and expandable, never dropped — the point is to stop them burying the steps
 * that changed something.
 */
function renderSteps(steps: TimelineStep[], turn: TurnGroup, blastRadius?: Map<string, BlastRadiusNote>) {
  const out: React.ReactNode[] = [];
  let run: TimelineStep[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) out.push(<Step key={run[0].id} step={run[0]} blastRadius={blastRadius?.get(run[0].id)} />);
    else out.push(<ExploredSummary key={`explored:${run[0].id}`} steps={run} />);
    run = [];
  };

  for (const step of steps) {
    const children = turn.childrenByParent.get(step.id);
    if (isExploratory(step) && !children) {
      run.push(step);
      continue;
    }
    flush();
    out.push(<Step key={step.id} step={step} children={children} blastRadius={blastRadius?.get(step.id)} />);
  }
  flush();

  return out;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
