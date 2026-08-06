import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventRow, ParentAttribution, SessionRow } from "@joystick/shared";
import { config } from "./config.js";

/**
 * Storage.
 *
 * `seq` is *arrival* order at the sidecar, not causal order in the session.
 * Hooks fire as independent async processes, so two events emitted microseconds
 * apart can arrive out of order. We keep seq as the authoritative append-log
 * position and preserve every correlation key (tool_use_id, agent_id,
 * prompt_id) so a later phase can reconstruct true causal order from the
 * transcript. Do not treat seq as ground truth about what Claude did first.
 */

export interface InsertEventInput {
  session_id: string;
  hook_event_name: string;
  tool_name?: string | null;
  tool_use_id?: string | null;
  agent_id?: string | null;
  agent_type?: string | null;
  prompt_id?: string | null;
  summary: string;
  known: boolean;
  raw: string;
  received_at_ms: number;
}

const SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id            TEXT PRIMARY KEY,
  cwd                   TEXT,
  transcript_path       TEXT,
  source                TEXT,
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  end_reason            TEXT,
  last_event_at         TEXT,
  last_event_at_ms      INTEGER,
  stop_received         INTEGER NOT NULL DEFAULT 0,
  session_end_received  INTEGER NOT NULL DEFAULT 0,
  last_end_kind         TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT NOT NULL,
  seq                INTEGER NOT NULL,
  hook_event_name    TEXT NOT NULL,
  tool_name          TEXT,
  tool_use_id        TEXT,
  agent_id           TEXT,
  agent_type         TEXT,
  prompt_id          TEXT,
  summary            TEXT NOT NULL,
  known              INTEGER NOT NULL DEFAULT 1,
  received_at        TEXT NOT NULL,
  received_at_ms     INTEGER NOT NULL,
  parent_tool_use_id TEXT,
  parent_attribution TEXT,
  raw                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_tool_use_id ON events (tool_use_id);
CREATE INDEX IF NOT EXISTS idx_events_agent_id    ON events (agent_id);
CREATE INDEX IF NOT EXISTS idx_events_parent      ON events (session_id, parent_tool_use_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_seq_uniq ON events (session_id, seq);
`;

/**
 * Views exist so these facts are queryable without a consumer reimplementing
 * the definitions. Created after column migration, since they reference columns
 * added by it.
 */
const SCHEMA_VIEWS = `
CREATE VIEW IF NOT EXISTS session_subagent_attribution AS
SELECT
  session_id,
  COUNT(*) AS total_subagent_events,
  SUM(CASE WHEN parent_attribution = 'unattributed' THEN 1 ELSE 0 END)
    AS unattributed_subagent_events,
  ROUND(
    100.0 * SUM(CASE WHEN parent_attribution = 'unattributed' THEN 1 ELSE 0 END) / COUNT(*),
    2
  ) AS unattributed_pct
FROM events
WHERE agent_id IS NOT NULL
GROUP BY session_id;

CREATE VIEW IF NOT EXISTS session_liveness AS
SELECT
  s.session_id,
  s.cwd,
  s.started_at,
  s.last_event_at,
  s.last_event_at_ms,
  s.stop_received,
  s.session_end_received,
  -- Phase 0 records only what was observed. Whether a session has *ended* is a
  -- judgement that needs an idle threshold, and that belongs to the panel.
  CASE WHEN s.stop_received = 1 OR s.session_end_received = 1 THEN 1 ELSE 0 END
    AS explicit_end_received,
  s.last_end_kind,
  s.ended_at,
  s.end_reason,
  (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS event_count
FROM sessions s;
`;

/** Columns added after the initial schema shipped, for databases that predate them. */
const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "events", column: "parent_tool_use_id", ddl: "ALTER TABLE events ADD COLUMN parent_tool_use_id TEXT" },
  { table: "events", column: "parent_attribution", ddl: "ALTER TABLE events ADD COLUMN parent_attribution TEXT" },
  { table: "sessions", column: "last_event_at", ddl: "ALTER TABLE sessions ADD COLUMN last_event_at TEXT" },
  { table: "sessions", column: "last_event_at_ms", ddl: "ALTER TABLE sessions ADD COLUMN last_event_at_ms INTEGER" },
  { table: "sessions", column: "stop_received", ddl: "ALTER TABLE sessions ADD COLUMN stop_received INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "session_end_received", ddl: "ALTER TABLE sessions ADD COLUMN session_end_received INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "last_end_kind", ddl: "ALTER TABLE sessions ADD COLUMN last_end_kind TEXT" },
];

export class Store {
  private db: Database.Database;
  private insertEventStmt: Database.Statement;
  private upsertSessionStmt: Database.Statement;
  private endSessionStmt: Database.Statement;
  private touchSessionStmt: Database.Statement;
  private unclaimedSpawnStmt: Database.Statement;
  private agentParentStmt: Database.Statement;

  constructor(dbPath: string = config.dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);

    // WAL lets the panel read while hooks are writing. NORMAL trades a
    // crash-window fsync for throughput, which is the right trade for an
    // observability log.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA_TABLES);
    this.migrate();
    this.db.exec(SCHEMA_VIEWS);

    this.insertEventStmt = this.db.prepare(`
      INSERT INTO events (
        session_id, seq, hook_event_name, tool_name, tool_use_id,
        agent_id, agent_type, prompt_id, summary, known,
        received_at, received_at_ms, parent_tool_use_id, parent_attribution, raw
      ) VALUES (
        @session_id,
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = @session_id),
        @hook_event_name, @tool_name, @tool_use_id,
        @agent_id, @agent_type, @prompt_id, @summary, @known,
        @received_at, @received_at_ms, @parent_tool_use_id, @parent_attribution, @raw
      )
    `);

    this.upsertSessionStmt = this.db.prepare(`
      INSERT INTO sessions (session_id, cwd, transcript_path, source, started_at)
      VALUES (@session_id, @cwd, @transcript_path, @source, @started_at)
      ON CONFLICT(session_id) DO UPDATE SET
        cwd             = COALESCE(excluded.cwd, sessions.cwd),
        transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path),
        source          = COALESCE(sessions.source, excluded.source)
    `);

    this.endSessionStmt = this.db.prepare(`
      UPDATE sessions SET ended_at = @ended_at, end_reason = @end_reason
      WHERE session_id = @session_id
    `);

    this.touchSessionStmt = this.db.prepare(`
      UPDATE sessions SET
        last_event_at        = @at,
        last_event_at_ms     = @at_ms,
        stop_received        = MAX(stop_received, @is_stop),
        session_end_received = MAX(session_end_received, @is_session_end),
        last_end_kind        = COALESCE(@end_kind, last_end_kind)
      WHERE session_id = @session_id
    `);

    // FIFO: the oldest Agent spawn in this session that no SubagentStart has
    // claimed yet. Resolved from SQLite rather than memory so that a sidecar
    // restart mid-session does not orphan agents that were correctly linkable.
    this.unclaimedSpawnStmt = this.db.prepare(`
      SELECT tool_use_id FROM events
      WHERE session_id = @session_id
        AND hook_event_name = 'PreToolUse'
        AND tool_name = 'Agent'
        AND tool_use_id IS NOT NULL
        AND tool_use_id NOT IN (
          SELECT parent_tool_use_id FROM events
          WHERE session_id = @session_id AND parent_tool_use_id IS NOT NULL
        )
      ORDER BY seq
      LIMIT 1
    `);

    // An agent's other events inherit whatever its SubagentStart resolved to.
    this.agentParentStmt = this.db.prepare(`
      SELECT parent_tool_use_id, parent_attribution FROM events
      WHERE session_id = @session_id AND agent_id = @agent_id
        AND hook_event_name = 'SubagentStart'
      ORDER BY seq LIMIT 1
    `);
  }

  private migrate(): void {
    for (const m of MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === m.column)) this.db.exec(m.ddl);
    }
  }

  /**
   * Decide a subagent event's parent at write time.
   *
   * Mirrors the FIFO-adjacency rule in `linkSubagents`; a test asserts the two
   * agree on the real parallel-subagent capture. Events outside a subagent get
   * no attribution at all — that is Phase 1's "root", and Phase 0 does not
   * invent it.
   */
  private resolveParent(input: InsertEventInput): {
    parent_tool_use_id: string | null;
    parent_attribution: ParentAttribution | null;
  } {
    if (!input.agent_id) return { parent_tool_use_id: null, parent_attribution: null };

    if (input.hook_event_name === "SubagentStart") {
      const row = this.unclaimedSpawnStmt.get({ session_id: input.session_id }) as
        | { tool_use_id: string }
        | undefined;
      return row
        ? { parent_tool_use_id: row.tool_use_id, parent_attribution: "linked" }
        : { parent_tool_use_id: null, parent_attribution: "unattributed" };
    }

    const inherited = this.agentParentStmt.get({
      session_id: input.session_id,
      agent_id: input.agent_id,
    }) as { parent_tool_use_id: string | null; parent_attribution: string | null } | undefined;

    // No SubagentStart on record — the sidecar started mid-subagent, or the
    // start was lost. Either way the parent is genuinely unknown.
    if (!inherited) return { parent_tool_use_id: null, parent_attribution: "unattributed" };

    return {
      parent_tool_use_id: inherited.parent_tool_use_id,
      parent_attribution: (inherited.parent_attribution as ParentAttribution) ?? "unattributed",
    };
  }

  /** Insert an event and return it with its assigned seq. Synchronous by design. */
  insertEvent(input: InsertEventInput): EventRow {
    const received_at = new Date(input.received_at_ms).toISOString();
    const parent = this.resolveParent(input);
    const info = this.insertEventStmt.run({
      session_id: input.session_id,
      hook_event_name: input.hook_event_name,
      tool_name: input.tool_name ?? null,
      tool_use_id: input.tool_use_id ?? null,
      agent_id: input.agent_id ?? null,
      agent_type: input.agent_type ?? null,
      prompt_id: input.prompt_id ?? null,
      summary: input.summary,
      known: input.known ? 1 : 0,
      received_at,
      received_at_ms: input.received_at_ms,
      parent_tool_use_id: parent.parent_tool_use_id,
      parent_attribution: parent.parent_attribution,
      raw: input.raw,
    });

    const row = this.db
      .prepare("SELECT seq FROM events WHERE id = ?")
      .get(info.lastInsertRowid) as { seq: number };

    return {
      id: Number(info.lastInsertRowid),
      session_id: input.session_id,
      seq: row.seq,
      hook_event_name: input.hook_event_name,
      tool_name: input.tool_name ?? null,
      tool_use_id: input.tool_use_id ?? null,
      agent_id: input.agent_id ?? null,
      agent_type: input.agent_type ?? null,
      prompt_id: input.prompt_id ?? null,
      received_at,
      summary: input.summary,
      parent_tool_use_id: parent.parent_tool_use_id,
      parent_attribution: parent.parent_attribution,
      raw: safeParse(input.raw),
    };
  }

  /**
   * Record that a session is still producing events, and whether an explicit
   * terminator has ever been seen.
   *
   * `Stop` fires per turn rather than per session, so it is stored separately
   * from `SessionEnd` — a session with `stop_received` and no `session_end_received`
   * is the ordinary state of a session between turns, not an ended one.
   */
  touchSession(input: {
    session_id: string;
    hook_event_name: string;
    received_at_ms: number;
  }): void {
    const isStop = input.hook_event_name === "Stop";
    const isSessionEnd = input.hook_event_name === "SessionEnd";
    this.touchSessionStmt.run({
      session_id: input.session_id,
      at: new Date(input.received_at_ms).toISOString(),
      at_ms: input.received_at_ms,
      is_stop: isStop ? 1 : 0,
      is_session_end: isSessionEnd ? 1 : 0,
      end_kind: isSessionEnd ? "SessionEnd" : isStop ? "Stop" : null,
    });
  }

  /** Per-session subagent attribution counts, from the SQL view. */
  attributionStats(session_id?: string): Array<{
    session_id: string;
    total_subagent_events: number;
    unattributed_subagent_events: number;
    unattributed_pct: number;
  }> {
    const sql = session_id
      ? "SELECT * FROM session_subagent_attribution WHERE session_id = ?"
      : "SELECT * FROM session_subagent_attribution";
    const args = session_id ? [session_id] : [];
    return this.db.prepare(sql).all(...args) as never;
  }

  /** Raw facts a liveness heuristic needs, without computing the verdict. */
  liveness(session_id?: string): unknown[] {
    const sql = session_id
      ? "SELECT * FROM session_liveness WHERE session_id = ?"
      : "SELECT * FROM session_liveness ORDER BY started_at DESC";
    const args = session_id ? [session_id] : [];
    return this.db.prepare(sql).all(...args) as unknown[];
  }

  upsertSession(input: {
    session_id: string;
    cwd?: string | null;
    transcript_path?: string | null;
    source?: string | null;
    started_at: string;
  }): void {
    this.upsertSessionStmt.run({
      session_id: input.session_id,
      cwd: input.cwd ?? null,
      transcript_path: input.transcript_path ?? null,
      source: input.source ?? null,
      started_at: input.started_at,
    });
  }

  endSession(session_id: string, end_reason: string | null, ended_at: string): void {
    this.endSessionStmt.run({ session_id, end_reason, ended_at });
  }

  recentEvents(limit = 200, session_id?: string): EventRow[] {
    const sql = session_id
      ? "SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?"
      : "SELECT * FROM events ORDER BY id DESC LIMIT ?";
    const args = session_id ? [session_id, limit] : [limit];
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map(toEventRow);
  }

  sessions(limit = 50): SessionRow[] {
    return this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS event_count
         FROM sessions s ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(limit) as SessionRow[];
  }

  close(): void {
    this.db.close();
  }

  /** Escape hatch for tests and the verification row dump. */
  get raw(): Database.Database {
    return this.db;
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function toEventRow(r: Record<string, unknown>): EventRow {
  return {
    id: r.id as number,
    session_id: r.session_id as string,
    seq: r.seq as number,
    hook_event_name: r.hook_event_name as string,
    tool_name: (r.tool_name as string) ?? null,
    tool_use_id: (r.tool_use_id as string) ?? null,
    agent_id: (r.agent_id as string) ?? null,
    agent_type: (r.agent_type as string) ?? null,
    prompt_id: (r.prompt_id as string) ?? null,
    received_at: r.received_at as string,
    summary: r.summary as string,
    parent_tool_use_id: (r.parent_tool_use_id as string) ?? null,
    parent_attribution: (r.parent_attribution as ParentAttribution) ?? null,
    raw: safeParse(r.raw as string),
  };
}
