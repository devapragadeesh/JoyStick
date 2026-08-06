import { useState } from "react";
import type { BlastRadiusNote, TimelineStep } from "@joystick/shared";
import { summarizeStep } from "./summarize.js";

/**
 * Per-step rendering.
 *
 * Every string here originates in a hook payload or a transcript file and is
 * therefore untrusted. It reaches the DOM only as a React text child — there is
 * no dangerouslySetInnerHTML anywhere in this panel.
 *
 * Default view is exactly one line: a status icon and `summarizeStep(step)`.
 * Everything else — stated intent, diff, output, the full command or path —
 * lives behind a single expand control. `intent` is present on only ~37% of
 * steps, so the default view cannot depend on it; it appears only inside the
 * expanded detail, as one more piece of context alongside the diff, never as
 * the thing standing in for a summary.
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
  blastRadius,
}: {
  step: TimelineStep;
  children?: TimelineStep[];
  depth?: number;
  blastRadius?: BlastRadiusNote;
}) {
  const isError = step.status === "error";
  const exploratory = EXPLORATORY.has(step.toolName ?? "");

  // Errors start expanded, same as Phase 1: a failure the user has to click to
  // even see the detail on is a failure they will miss. The one-line summary
  // above already carries the "Failed: " prefix regardless of this state, so
  // this only controls whether the diff/output is immediately visible.
  const [open, setOpen] = useState(isError);
  const [childrenOpen, setChildrenOpen] = useState(false);

  const hasDetail = step.intent !== null || step.diff || step.output || step.target || step.durationMs !== undefined;

  return (
    <li className={`step step-${step.status} ${depth > 0 ? "step-nested" : ""}`}>
      <button
        className="step-row"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!hasDetail}
      >
        <span className={`bullet bullet-${step.status}`} aria-hidden>
          {step.status === "pending" ? "◌" : step.status === "error" ? "✕" : "●"}
        </span>
        <span className="step-summary">{summarizeStep(step)}</span>
        {step.status === "pending" && <span className="inflight">in flight</span>}
        {hasDetail && (
          <span className="chevron" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        )}
      </button>

      {blastRadius && <BlastRadius note={blastRadius} />}

      {open && hasDetail && (
        <div className="step-body">
          {step.durationMs !== undefined && (
            <p className="step-meta muted">{formatDuration(step.durationMs)}</p>
          )}
          {step.target && <Context step={step} />}
          <Intent step={step} />
          {step.diff && <Diff diff={step.diff} />}
          {step.output && !step.diff && <Output text={step.output} exploratory={exploratory} />}
        </div>
      )}

      {children && children.length > 0 && (
        <div className="children">
          {/*
            A subagent group is narrated here, at the group level, rather than
            per nested step: the steps inside have no reasoning of their own to
            show, so the honest summary is what was asked and what came back.
          */}
          <Delegation step={step} />
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
 * The full path or command the one-line summary truncated or omitted.
 *
 * Shown in the expanded detail so nothing is lost by moving the default view
 * to a fixed-format summary — Bash's full command in particular would
 * otherwise be unrecoverable past 50 characters.
 */
function Context({ step }: { step: TimelineStep }) {
  return (
    <p className="step-context">
      <span className="step-context-label">{step.toolName === "Bash" ? "command" : "target"}</span>
      <code>{step.target}</code>
    </p>
  );
}

/**
 * Intent is additive detail inside the expanded view, same tier as the diff —
 * not the thing the default view leans on. Rendered only when present: the
 * null case needs no placeholder now that the default view always shows the
 * one-line summary regardless of whether intent exists.
 */
function Intent({ step }: { step: TimelineStep }) {
  if (step.intent === null) return null;
  return (
    <div className="intent-block">
      <span className="intent-block-label">Claude's reasoning</span>
      <p className={`intent intent-${step.intentSource}`}>{step.intent}</p>
    </div>
  );
}

/**
 * Phase 3's inline note: always visible (not gated behind the expand toggle,
 * unlike intent/diff/output) since "what did this ripple into" is the point
 * of showing it at all — burying it behind a click would defeat that. Never
 * claims completeness it doesn't have: `truncated`/`!inGraph` are stated
 * plainly rather than a silently-shorter list.
 */
function BlastRadius({ note }: { note: BlastRadiusNote }) {
  return (
    <p className="blast-radius-note">
      <span className="blast-radius-label">ripple</span>
      {note.summary}
      {note.testCoverageNote && <span className="muted"> · {note.testCoverageNote}</span>}
    </p>
  );
}

/**
 * What the parent delegated, and what came back.
 *
 * Both strings already exist in the captured data — the Agent call's prompt and
 * the subagent's `last_assistant_message`. Neither is generated, and neither is
 * an `intent`: nested steps keep `intent: null` and show the ordinary
 * no-stated-reasoning marker.
 */
function Delegation({ step }: { step: TimelineStep }) {
  const [open, setOpen] = useState(false);
  if (!step.delegationPrompt && !step.returnedSummary) return null;

  return (
    <div className="delegation">
      {step.delegationPrompt && (
        <p className="delegation-line">
          <span className="delegation-label">asked</span>
          {clip(step.delegationPrompt, open ? Infinity : 220)}
        </p>
      )}
      {step.returnedSummary && (
        <p className="delegation-line">
          <span className="delegation-label">returned</span>
          {clip(step.returnedSummary, open ? Infinity : 220)}
        </p>
      )}
      {needsClip(step, 220) && (
        <button className="children-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? "show less" : "show full"}
        </button>
      )}
    </div>
  );
}

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function needsClip(step: TimelineStep, max: number): boolean {
  return (
    (step.delegationPrompt?.trim().length ?? 0) > max ||
    (step.returnedSummary?.trim().length ?? 0) > max
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

/**
 * One-line collapsed form for a run of exploratory steps.
 *
 * Uses the same "Looked through N files" phrasing as a lone Read/Grep/Glob
 * step's `summarizeStep` line, since this group header is standing in for
 * exactly that line across several calls at once — not a different concept.
 */
export function ExploredSummary({ steps }: { steps: TimelineStep[] }) {
  const [open, setOpen] = useState(false);
  const targets = steps.map((s) => s.target).filter(Boolean);

  return (
    <li className="step step-explored">
      <button className="step-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="bullet bullet-ok" aria-hidden>
          ●
        </span>
        <span className="step-summary">
          Looked through {steps.length} file{steps.length === 1 ? "" : "s"}
          {targets.length > 0 ? ` · ${targets.slice(0, 3).join(", ")}` : ""}
          {targets.length > 3 ? " …" : ""}
        </span>
        <span className="chevron" aria-hidden>
          {open ? "▾" : "▸"}
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
