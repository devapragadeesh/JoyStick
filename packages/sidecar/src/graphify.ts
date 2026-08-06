import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { mapGraphifyOutput, type MapResult } from "@joystick/shared";

const execFileAsync = promisify(execFile);

/**
 * Subprocess wrapper around graphify.
 *
 * graphify never runs on any schedule or hook of its own — the spike found its
 * own hook integration synchronous and directive-injecting, incompatible with
 * every constraint this project has held since Phase 0. It is invoked only
 * from here, only as an async subprocess, only in response to joystick's own
 * hooks (SessionStart, debounced PostToolUse). See extraction.ts.
 */

/** Resolve the graphify binary without assuming it's on a service's PATH. */
export function resolveGraphifyBinary(): string | null {
  if (process.env.GRAPHIFY_BIN && existsSync(process.env.GRAPHIFY_BIN)) {
    return process.env.GRAPHIFY_BIN;
  }
  const candidates = [
    join(homedir(), ".local", "bin", "graphify"), // uv tool install / pipx default
    "/usr/local/bin/graphify",
    "/opt/homebrew/bin/graphify",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export interface ExtractOptions {
  repoRoot: string;
  outDir: string;
  /**
   * Use `graphify update` instead of a full `extract`.
   *
   * Benchmarked in Phase 2 on joystick's own repo (~51 files) and rejected: a
   * single one-line comment addition, which changes zero AST nodes, produced
   * 414→450 nodes / 624→653 edges under `update` — while a fresh full extract
   * of the identical edited tree correctly reproduced 414/624, unchanged. Wall
   * clock was statistically indistinguishable between the two (~1.0-1.2s
   * either way on this repo size). `update` is therefore not just
   * non-incremental in the time sense, it is measurably incorrect — the
   * orchestration layer (codegraph-extraction.ts) never sets this to true.
   * The option is kept on the wrapper only so the finding has somewhere to be
   * documented next to the code it concerns, and in case a future graphify
   * release fixes it and this decision needs revisiting.
   */
  incremental?: boolean;
  timeoutMs?: number;
}

export interface ExtractOutcome {
  ok: boolean;
  wallMs: number;
  stderr: string;
  reason?: string;
}

/**
 * Run graphify and return once it's done. The caller is responsible for never
 * calling this synchronously from a hook — it belongs behind `setImmediate`/an
 * async hook handler, never awaited inline with a request that must return
 * quickly.
 *
 * `--code-only` is passed unconditionally: this is the flag confirmed in the
 * spike to require no API key and make no network call, re-confirmed directly
 * in this session with credentials unset and `lsof` polled through the run.
 * Nothing here ever grows an `--api-key`/backend flag.
 */
export async function runExtraction(opts: ExtractOptions): Promise<ExtractOutcome> {
  const bin = resolveGraphifyBinary();
  if (!bin) {
    return { ok: false, wallMs: 0, stderr: "", reason: "graphify binary not found" };
  }

  const args = opts.incremental
    ? ["update", opts.repoRoot]
    : ["extract", opts.repoRoot, "--code-only", "--out", opts.outDir];

  const started = performance.now();
  try {
    const { stderr } = await execFileAsync(bin, args, {
      timeout: opts.timeoutMs ?? 120_000,
      // graphify reads no credentials for --code-only, but strip provider keys
      // defensively anyway so a future flag change can't silently start
      // spending them.
      env: stripProviderKeys(process.env),
    });
    return { ok: true, wallMs: performance.now() - started, stderr };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return {
      ok: false,
      wallMs: performance.now() - started,
      stderr: e.stderr ?? "",
      reason: e.message ?? "graphify process failed",
    };
  }
}

function stripProviderKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped = { ...env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "KIMI_API_KEY",
    "DEEPSEEK_API_KEY",
  ]) {
    delete stripped[key];
  }
  return stripped;
}

/**
 * Read and validate the graph.json an extraction produced.
 *
 * Never throws. A malformed or unexpected shape is a `MapFailure`, logged by
 * the caller and treated as "skip this update" — the previous cached graph
 * (if any) stays in place rather than being replaced with something broken or
 * empty.
 */
export function readAndMapGraph(outDir: string): MapResult | { ok: false; reason: string } {
  const path = join(outDir, "graphify-out", "graph.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, reason: `could not read/parse ${path}: ${(err as Error).message}` };
  }
  return mapGraphifyOutput(raw);
}
