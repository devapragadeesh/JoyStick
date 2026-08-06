import { describe, expect, it } from "vitest";
import type { TimelineStep } from "@joystick/shared";
import { summarizeStep } from "./summarize.js";

function step(overrides: Partial<TimelineStep>): TimelineStep {
  return {
    id: "s1",
    sessionId: "sess",
    seq: 1,
    displayOrder: 1,
    displayOrderProvisional: false,
    turnId: "t1",
    kind: "tool",
    intent: null,
    intentSource: null,
    parentAttribution: "root",
    status: "ok",
    ...overrides,
  };
}

describe("summarizeStep", () => {
  it("names an Edit by its file's basename", () => {
    expect(summarizeStep(step({ toolName: "Edit", target: "/a/b/c/index.ts" }))).toBe(
      "Edited index.ts",
    );
  });

  it("names a Write as created", () => {
    expect(summarizeStep(step({ toolName: "Write", target: "/a/b/new.md" }))).toBe(
      "Created new.md",
    );
  });

  it("shows the command for Bash, truncated to ~50 chars", () => {
    const long = "x".repeat(80);
    const result = summarizeStep(step({ toolName: "Bash", target: long }));
    expect(result.startsWith("Ran: ")).toBe(true);
    expect(result.length).toBeLessThan(70);
    expect(result.endsWith("…")).toBe(true);
  });

  it("does not truncate a short Bash command", () => {
    expect(summarizeStep(step({ toolName: "Bash", target: "npm test" }))).toBe("Ran: npm test");
  });

  it("summarizes Read as looking through a file", () => {
    expect(summarizeStep(step({ toolName: "Read", target: "/a/b.ts" }))).toBe(
      "Looked through 1 file",
    );
  });

  it("summarizes Grep and Glob the same way as Read", () => {
    expect(summarizeStep(step({ toolName: "Grep", target: "foo" }))).toBe("Looked through 1 file");
    expect(summarizeStep(step({ toolName: "Glob", target: "**/*.ts" }))).toBe(
      "Looked through 1 file",
    );
  });

  it("describes a subagent delegation by its prompt", () => {
    expect(
      summarizeStep(
        step({ kind: "subagent", toolName: "Agent", delegationPrompt: "find all the JS files" }),
      ),
    ).toBe("Asked a subagent to find all the JS files");
  });

  it("describes a task by its title when there is no delegation prompt", () => {
    expect(summarizeStep(step({ kind: "task", target: "Define withRetry helper" }))).toBe(
      "Asked a subagent to Define withRetry helper",
    );
  });

  it("falls back to the literal tool name for anything unrecognized", () => {
    expect(summarizeStep(step({ toolName: "SomeFutureTool" }))).toBe("SomeFutureTool");
  });

  it("falls back to kind when there is no tool name at all", () => {
    expect(summarizeStep(step({ kind: "tool", toolName: undefined }))).toBe("tool");
  });

  it("prefixes a failed step with Failed:, regardless of kind", () => {
    expect(summarizeStep(step({ toolName: "Bash", target: "npm test", status: "error" }))).toBe(
      "Failed: Ran: npm test",
    );
    expect(
      summarizeStep(step({ toolName: "Edit", target: "/a.ts", status: "error" })),
    ).toBe("Failed: Edited a.ts");
  });

  it("is never blank for any step", () => {
    const cases = [
      step({}),
      step({ toolName: undefined, target: undefined }),
      step({ kind: "subagent", toolName: "Agent" }),
      step({ kind: "task" }),
      step({ toolName: "Edit", target: undefined }),
      step({ toolName: "Bash", target: undefined }),
    ];
    for (const c of cases) {
      expect(summarizeStep(c).length).toBeGreaterThan(0);
    }
  });

  it("never reads step.intent", () => {
    // The whole point: identical steps differing only in intent must summarize
    // identically. A getter that throws on access proves the field is never
    // touched, not merely that its value happens not to change the output.
    const withoutTouchingIntent: TimelineStep = step({
      toolName: "Bash",
      target: "npm test",
      intentSource: "text",
    });
    Object.defineProperty(withoutTouchingIntent, "intent", {
      get() {
        throw new Error("summarizeStep must not read intent");
      },
    });
    expect(() => summarizeStep(withoutTouchingIntent)).not.toThrow();
    expect(summarizeStep(withoutTouchingIntent)).toBe("Ran: npm test");
  });

  it("produces an identical line for a step with intent and its intent-free twin", () => {
    // This is the property the whole change exists to guarantee: the default
    // view must not differ based on whether intent happened to be captured.
    const withIntent = step({
      toolName: "Edit",
      target: "/src/greet.js",
      intent: "I'll add a JSDoc block here.",
      intentSource: "text",
    });
    const withoutIntent = step({ ...withIntent, intent: null, intentSource: null });
    expect(summarizeStep(withIntent)).toBe(summarizeStep(withoutIntent));
  });
});
