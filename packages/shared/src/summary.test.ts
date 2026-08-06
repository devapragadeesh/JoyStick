import { describe, expect, it } from "vitest";
import { summarize } from "./summary.js";
import type { Envelope } from "./events.js";

const ev = (o: Record<string, unknown>) => ({ session_id: "s", ...o }) as Envelope;

describe("summarize", () => {
  it("leads with the pattern for search tools, not the search root", () => {
    expect(
      summarize(
        ev({
          hook_event_name: "PreToolUse",
          tool_name: "Grep",
          tool_input: { pattern: "fetchJson", path: "/repo/src" },
        }),
      ),
    ).toBe("Grep /fetchJson/ in repo/src");
  });

  it("does not put regex delimiters around a glob", () => {
    expect(
      summarize(
        ev({
          hook_event_name: "PreToolUse",
          tool_name: "Glob",
          tool_input: { pattern: "**/*.test.ts" },
        }),
      ),
    ).toBe("Glob **/*.test.ts");
  });

  it("shortens a file path to its last two segments", () => {
    expect(
      summarize(
        ev({
          hook_event_name: "PostToolUse",
          tool_name: "Read",
          tool_input: { file_path: "/a/b/c/d/index.ts" },
        }),
      ),
    ).toBe("Read d/index.ts");
  });

  it("collapses whitespace and truncates long prompts", () => {
    const s = summarize(
      ev({ hook_event_name: "UserPromptSubmit", prompt: `${"x".repeat(500)}\n\n  y` }),
    );
    expect(s.length).toBeLessThanOrEqual(120);
    expect(s.endsWith("…")).toBe(true);
  });

  it("names the failing tool and its error", () => {
    expect(
      summarize(
        ev({
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_input: { command: "npm test" },
          tool_error: "1 failing",
        }),
      ),
    ).toBe("Bash npm test — 1 failing");
  });

  it("falls back to the event name for an unmodelled event", () => {
    expect(summarize(ev({ hook_event_name: "SomeFutureEvent" }))).toBe("SomeFutureEvent");
  });

  it("handles a tool call with no recognisable input", () => {
    expect(
      summarize(ev({ hook_event_name: "PreToolUse", tool_name: "Weird", tool_input: {} })),
    ).toBe("Weird");
  });

  it("survives a null tool_input", () => {
    expect(
      summarize(ev({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: null })),
    ).toBe("Read");
  });
});
