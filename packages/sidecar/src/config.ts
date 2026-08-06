import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the plugin's persistent data lives.
 *
 * The docs define ${CLAUDE_PLUGIN_DATA} as ~/.claude/plugins/data/{id}/, where
 * {id} is the plugin identifier with characters outside [a-zA-Z0-9_-] replaced
 * by '-'. That directory survives plugin updates, unlike CLAUDE_PLUGIN_ROOT.
 *
 * The sidecar is usually started by hand rather than by Claude Code, so the env
 * var is often absent; we reconstruct the same path when it is.
 */
function defaultDataDir(): string {
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA;
  if (fromEnv) return fromEnv;
  return join(homedir(), ".claude", "plugins", "data", "joystick");
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  /**
   * CLAUDE_PLUGIN_OPTION_PORT is how the userConfig `port` option reaches a
   * process; JOYSTICK_PORT is the override for running the sidecar standalone.
   */
  port: num(process.env.JOYSTICK_PORT ?? process.env.CLAUDE_PLUGIN_OPTION_PORT, 8787),

  /** Loopback only. Never 0.0.0.0 — this database holds whole sessions. */
  host: "127.0.0.1" as const,

  dataDir: process.env.JOYSTICK_DATA_DIR ?? defaultDataDir(),

  get dbPath(): string {
    return process.env.JOYSTICK_DB ?? join(this.dataDir, "joystick.db");
  },

  /** Cap on a single stored payload, guarding against a runaway tool_result. */
  maxPayloadBytes: num(process.env.JOYSTICK_MAX_PAYLOAD, 8 * 1024 * 1024),

  /**
   * B.5's claude-cli guardrail: N calls per rolling hour, server-side,
   * backed by the claude_cli_calls ledger so it survives a sidecar restart
   * within the window. Only claude-cli is limited — ollama and
   * openai-compatible are unaffected by this value.
   */
  claudeCliRateLimitPerHour: num(process.env.JOYSTICK_CLAUDE_CLI_RATE_LIMIT, 20),
  claudeCliRateLimitWindowMs: 60 * 60 * 1000,

  /** Phase 3: reverse-closure hop limit. See blastRadius.ts for why 3 is the default. */
  blastRadiusMaxDepth: num(process.env.JOYSTICK_BLAST_RADIUS_DEPTH, 3),
};
