import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AssembledContext, OllamaConfig, OpenAICompatibleConfig } from "@joystick/shared";

const execFileAsync = promisify(execFile);

/**
 * Provider dispatch (B.4/B.5) — one function per provider kind, all fed the
 * exact same assembled context and returning the same shape. Escalating to a
 * "stronger" provider is just calling a different one of these with the same
 * question; there is no separate escalation code path.
 */

export function buildPromptText(question: string, context: AssembledContext): string {
  const sections = context.files.map((f) => {
    const header = `### ${f.filePath}${f.truncated ? " (truncated)" : ""}`;
    const body = f.content.length > 0 ? f.content : "(file could not be read)";
    const imports = f.imports.length > 0 ? f.imports.join(", ") : "(none)";
    const importedBy = f.importedBy.length > 0 ? f.importedBy.join(", ") : "(none)";
    const steps =
      f.timelineSteps.length > 0
        ? f.timelineSteps
            .map((s) => `  - ${s.toolName ?? "unknown tool"} (${s.status}): ${s.intent ?? "no stated reason"}`)
            .join("\n")
        : "  (none)";
    return [
      header,
      "```",
      body,
      "```",
      `Direct imports: ${imports}`,
      `Directly imported by: ${importedBy}`,
      `Timeline: ${f.timelineNote}`,
      steps,
    ].join("\n");
  });

  const intro =
    sections.length > 0
      ? [
          "You are answering a question about a codebase using only the context below.",
          "Do not run commands or access anything outside this context — answer from it alone,",
          "and say so explicitly if the context doesn't contain what's needed.",
        ]
      : [
          "You are answering a general question about a codebase. No specific files were",
          "selected as context for this question, so answer from general knowledge and the",
          "question itself where that's genuinely possible.",
          "If the question depends on details of this specific codebase that you cannot know",
          "without seeing its files (e.g. \"what does this folder do\"), say so plainly and",
          "suggest the user select the relevant file(s) or folder for context — do not invent",
          "plausible-sounding specifics about a codebase you have not been shown.",
          "Do not run commands or access anything outside this prompt.",
        ];

  return [...intro, "", ...sections, "", `Question: ${question}`].join("\n");
}

export interface ProviderAnswer {
  text: string;
}

/**
 * `--tools ""` empirically confirmed (Phase-prior spike) to disable all tool
 * execution for a headless `claude -p` call — this is what keeps a
 * browser-originated question from ever gaining real filesystem/bash access
 * through the sidecar.
 */
export async function askClaudeCli(promptText: string, timeoutMs = 60_000): Promise<ProviderAnswer> {
  const { stdout } = await execFileAsync("claude", ["-p", promptText, "--tools", ""], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { text: stdout.trim() };
}

export async function askOllama(config: OllamaConfig, promptText: string, timeoutMs = 60_000): Promise<ProviderAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Ollama's default context window (historically 2048 tokens) applies
      // regardless of what the model itself supports, and it truncates
      // rather than erroring — indistinguishable from "the model just
      // doesn't have the context." A single capped-at-8000-char file from
      // assembleContext already exceeds the default, so this has to be set
      // explicitly for multi-file context to actually reach the model.
      body: JSON.stringify({
        model: config.model,
        prompt: promptText,
        stream: false,
        options: { num_ctx: 8192 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ollama responded ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { response?: string };
    return { text: (body.response ?? "").trim() };
  } finally {
    clearTimeout(timer);
  }
}

export async function askOpenAICompatible(
  config: OpenAICompatibleConfig,
  promptText: string,
  timeoutMs = 60_000,
): Promise<ProviderAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: promptText }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${config.baseUrl} responded ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { text: (body.choices?.[0]?.message?.content ?? "").trim() };
  } finally {
    clearTimeout(timer);
  }
}
