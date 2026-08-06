import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventRow, SessionRow } from "@joystick/shared";
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  cwd             TEXT,
  transcript_path TEXT,
  source          TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  end_reason      TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  hook_event_name TEXT NOT NULL,
  tool_name       TEXT,
  tool_use_id     TEXT,
  agent_id        TEXT,
  agent_type      TEXT,
  prompt_id       TEXT,
  summary         TEXT NOT NULL,
  known           INTEGER NOT NULL DEFAULT 1,
  received_at     TEXT NOT NULL,
  received_at_ms  INTEGER NOT NULL,
  raw             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_tool_use_id ON events (tool_use_id);
CREATE INDEX IF NOT EXISTS idx_events_agent_id    ON events (agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_seq_uniq ON events (session_id, seq);
`;

export class Store {
  private db: Database.Database;
  private insertEventStmt: Database.Statement;
  private upsertSessionStmt: Database.Statement;
  private endSessionStmt: Database.Statement;

  constructor(dbPath: string = config.dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);

    // WAL lets the panel read while hooks are writing. NORMAL trades a
    // crash-window fsync for throughput, which is the right trade for an
    // observability log.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);

    this.insertEventStmt = this.db.prepare(`
      INSERT INTO events (
        session_id, seq, hook_event_name, tool_name, tool_use_id,
        agent_id, agent_type, prompt_id, summary, known,
        received_at, received_at_ms, raw
      ) VALUES (
        @session_id,
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = @session_id),
        @hook_event_name, @tool_name, @tool_use_id,
        @agent_id, @agent_type, @prompt_id, @summary, @known,
        @received_at, @received_at_ms, @raw
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
  }

  /** Insert an event and return it with its assigned seq. Synchronous by design. */
  insertEvent(input: InsertEventInput): EventRow {
    const received_at = new Date(input.received_at_ms).toISOString();
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
      raw: safeParse(input.raw),
    };
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
    raw: safeParse(r.raw as string),
  };
}
