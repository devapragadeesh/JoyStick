import type { TimelineStep } from "@joystick/shared";

/**
 * The one line every step shows by default.
 *
 * Deterministic and total: every `TimelineStep` produces a non-empty string,
 * from the step's own tool/target/kind data only. `intent` is never read here —
 * it is present on ~37% of steps, and a summary line that depended on it would
 * leave the other 63% blank in the one place blank is not an option, since
 * there is no longer a lower tier to fall back to.
 */
export function summarizeStep(step: TimelineStep): string {
  const line = describe(step);
  return step.status === "error" ? `Failed: ${line}` : line;
}

function describe(step: TimelineStep): string {
  const tool = step.toolName;

  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") {
    const file = basename(step.target);
    const verb = tool === "Write" ? "Created" : "Edited";
    return file ? `${verb} ${file}` : verb;
  }

  if (tool === "Bash") {
    return step.target ? `Ran: ${truncate(step.target, 50)}` : "Ran a command";
  }

  if (tool === "Read" || tool === "Grep" || tool === "Glob" || tool === "NotebookRead") {
    return "Looked through 1 file";
  }

  // Task/subagent share one phrasing: a TaskCreated step and an Agent
  // delegation are both "work Claude handed off", described by what was asked.
  if (step.kind === "subagent" || step.kind === "task") {
    const asked = step.delegationPrompt ?? step.target;
    return asked ? `Asked a subagent to ${truncate(asked, 50)}` : "Asked a subagent to help";
  }

  // Literal fallback. Never blank: an unrecognized tool still names itself.
  return tool ?? step.kind;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function basename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}
