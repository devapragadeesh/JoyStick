import { useState } from "react";
import type { TimelineStep } from "@joystick/shared";

/**
 * Per-step rendering.
 *
 * Every string here originates in a hook payload or a transcript file and is
 * therefore untrusted. It reaches the DOM only as a React text child — there is
 * no dangerouslySetInnerHTML anywhere in this panel.
 */

const EXPLORATORY = new Set(["Read", "Grep", "Glob", "NotebookRead"]);

/** Collapse a diff to changed hunks with a few lines of context either side. */
export function collapseDiff(diff: string, context = 3): { lines: string[]; hidden: number } {
  const lines = diff.split("\n");
  const changed = lines.map((l) => l.startsWith("+") || l.startsWith("-"));
  const keep = new Set<number>();

  changed.forEach((isChanged, i) => {
    if (!isChanged) return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
      keep.add(j);
    }
  });

  if (keep.size === 0) return { lines: lines.slice(0, 10), hidden: Math.max(0, lines.length - 10) };
  const kept = [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  return { lines: kept, hidden: lines.length - kept.length };
}

function truncate(text: string, max = 2000): { text: string; truncated: boolean } {
  return text.length <= max
    ? { text, truncated: false }
    : { text: text.slice(0, max), truncated: true };
}

export function Step({
  step,
  children,
  depth = 0,
}: {
  step: TimelineStep;
  children?: TimelineStep[];
  depth?: number;
}) {
  const isError = step.status === "error";
  const exploratory = EXPLORATORY.has(step.toolName ?? "");

  // Errors never start collapsed, whatever their type — a failure the user has
  // to expand to notice is a failure they will miss.
  const [open, setOpen] = useState(isError);
  const [childrenOpen, setChildrenOpen] = useState(false);

  return (
    <li className={`step step-${step.status} ${depth > 0 ? "step-nested" : ""}`}>
      <button className="step-row" onClick={() => setOpen((o) => !o)}>
        <span className={`bullet bullet-${step.status}`} aria-hidden>
          {step.status === "pending" ? "◌" : step.status === "error" ? "✕" : "●"}
        </span>
        <span className="step-tool">{step.toolName ?? step.kind}</span>
        {step.target && <span className="step-target">{step.target}</span>}
        {step.status === "pending" && <span className="inflight">in flight</span>}
        {step.durationMs !== undefined && (
          <span className="step-duration">{formatDuration(step.durationMs)}</span>
        )}
      </button>

      <Intent step={step} />

      {open && (
        <div className="step-body">
          {step.diff && <Diff diff={step.diff} />}
          {step.output && !step.diff && <Output text={step.output} exploratory={exploratory} />}
          {!step.diff && !step.output && <p className="muted">No output recorded.</p>}
        </div>
      )}

      {children && children.length > 0 && (
        <div className="children">
          <button className="children-toggle" onClick={() => setChildrenOpen((o) => !o)}>
            {childrenOpen ? "▾" : "▸"} {children.length} subagent step
            {children.length === 1 ? "" : "s"}
          </button>
          {childrenOpen && (
            <ol className="steps">
              {children.map((c) => (
                <Step key={c.id} step={c} depth={depth + 1} />
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Intent is shown verbatim or marked explicitly absent. A blank space would
 * read as "still loading" rather than "Claude said nothing here", which is the
 * one misreading that would make this panel worse than no panel.
 */
function Intent({ step }: { step: TimelineStep }) {
  if (step.intent === null) {
    return <p className="intent intent-none">no stated reasoning</p>;
  }
  return (
    <p className={`intent intent-${step.intentSource}`}>
      <span className="intent-source">{step.intentSource}</span>
      {step.intent}
    </p>
  );
}

function Diff({ diff }: { diff: string }) {
  const { lines, hidden } = collapseDiff(diff);
  return (
    <pre className="diff">
      {lines.map((line, i) => (
        <div
          key={i}
          className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx"}
        >
          {line}
        </div>
      ))}
      {hidden > 0 && <div className="ctx muted">… {hidden} unchanged lines</div>}
    </pre>
  );
}

function Output({ text, exploratory }: { text: string; exploratory: boolean }) {
  const { text: shown, truncated } = truncate(text, exploratory ? 600 : 2000);
  return (
    <pre className="output">
      {shown}
      {truncated && <span className="muted">{"\n… truncated"}</span>}
    </pre>
  );
}

/** One-line collapsed form for a run of exploratory steps. */
export function ExploredSummary({ steps }: { steps: TimelineStep[] }) {
  const [open, setOpen] = useState(false);
  const targets = steps.map((s) => s.target).filter(Boolean);

  return (
    <li className="step step-explored">
      <button className="step-row" onClick={() => setOpen((o) => !o)}>
        <span className="bullet bullet-ok" aria-hidden>
          ●
        </span>
        <span className="step-tool">explored</span>
        <span className="step-target">
          {steps.length} {steps.length === 1 ? "call" : "calls"}
          {targets.length > 0 ? ` · ${targets.slice(0, 3).join(", ")}` : ""}
          {targets.length > 3 ? " …" : ""}
        </span>
      </button>
      {open && (
        <ol className="steps">
          {steps.map((s) => (
            <Step key={s.id} step={s} depth={1} />
          ))}
        </ol>
      )}
    </li>
  );
}

export function isExploratory(step: TimelineStep): boolean {
  // An exploratory call that failed is not routine and must not be folded away.
  return EXPLORATORY.has(step.toolName ?? "") && step.status === "ok";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
