import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CodeEdge,
  CodeGraph,
  CodeGraphMeta,
  CodeNode,
  EventRow,
  ParentAttribution,
  SessionRow,
} from "@joystick/shared";

export type CodeGraphMetaRow = CodeGraphMeta;
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

-- Phase 1: transcript-derived state. Kept in its own tables because it is
-- backfilled asynchronously and may lag arbitrarily behind the hook log.
CREATE TABLE IF NOT EXISTS transcript_offsets (
  transcript_path TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  byte_offset     INTEGER NOT NULL DEFAULT 0,
  line_index      INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS transcript_entries (
  transcript_path TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  uuid            TEXT NOT NULL,
  parent_uuid     TEXT,
  line_index      INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  tool_use_id     TEXT,
  tool_name       TEXT,
  text            TEXT,
  PRIMARY KEY (transcript_path, uuid, kind, line_index)
);

CREATE TABLE IF NOT EXISTS tool_intents (
  session_id     TEXT NOT NULL,
  tool_use_id    TEXT NOT NULL,
  transcript_pos INTEGER NOT NULL,
  intent         TEXT,
  intent_source  TEXT,
  PRIMARY KEY (session_id, tool_use_id)
);

CREATE INDEX IF NOT EXISTS idx_transcript_uuid ON transcript_entries (transcript_path, uuid);
CREATE INDEX IF NOT EXISTS idx_tool_intents_session ON tool_intents (session_id);

-- Phase 2: static architecture map. Chose SQLite over a flat JSON file so the
-- graph is queryable the same way as everything else in this file (transactional
-- replace, indexed neighbor lookups for Phase 2.5's click-to-highlight, and a
-- natural home for Phase 3's reverse-dependency queries) rather than fragmenting
-- storage across a second file format. One graph per joystick instance — Phase 2
-- is scoped to a single repo, so code_graph_meta is a singleton row.
CREATE TABLE IF NOT EXISTS code_graph_meta (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  repo_root              TEXT NOT NULL,
  extracted_at           TEXT NOT NULL,
  built_at_commit        TEXT,
  extraction_mode        TEXT NOT NULL,
  wall_ms                INTEGER NOT NULL,
  node_count             INTEGER NOT NULL,
  edge_count             INTEGER NOT NULL,
  dropped_inferred_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS code_nodes (
  id            TEXT PRIMARY KEY,
  file_path     TEXT NOT NULL,
  content_hash  TEXT
);

CREATE TABLE IF NOT EXISTS code_edges (
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL,
  kind     TEXT NOT NULL,
  source   TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);

CREATE INDEX IF NOT EXISTS idx_code_edges_from ON code_edges (from_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_to   ON code_edges (to_id);
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

  // ---- Phase 1: transcript state ----

  /** Sessions with a known transcript, newest first — what the tailer polls. */
  transcriptTargets(): Array<{ session_id: string; transcript_path: string }> {
    return this.db
      .prepare(
        `SELECT session_id, transcript_path FROM sessions
         WHERE transcript_path IS NOT NULL
         ORDER BY COALESCE(last_event_at_ms, 0) DESC
         LIMIT 50`,
      )
      .all() as Array<{ session_id: string; transcript_path: string }>;
  }

  transcriptOffset(path: string): { byte_offset: number; line_index: number } {
    const row = this.db
      .prepare("SELECT byte_offset, line_index FROM transcript_offsets WHERE transcript_path = ?")
      .get(path) as { byte_offset: number; line_index: number } | undefined;
    return row ?? { byte_offset: 0, line_index: 0 };
  }

  setTranscriptOffset(path: string, sessionId: string, byteOffset: number, lineIndex: number): void {
    this.db
      .prepare(
        `INSERT INTO transcript_offsets (transcript_path, session_id, byte_offset, line_index, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(transcript_path) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           line_index  = excluded.line_index,
           updated_at  = excluded.updated_at`,
      )
      .run(path, sessionId, byteOffset, lineIndex, new Date().toISOString());
  }

  /** Drop derived state for a transcript that was truncated or replaced. */
  clearTranscript(path: string): void {
    this.db.prepare("DELETE FROM transcript_entries WHERE transcript_path = ?").run(path);
    this.db.prepare("DELETE FROM transcript_offsets WHERE transcript_path = ?").run(path);
  }

  insertTranscriptEntries(
    path: string,
    sessionId: string,
    entries: Array<{
      uuid: string;
      parent_uuid: string | null;
      line_index: number;
      kind: string;
      tool_use_id: string | null;
      tool_name: string | null;
      text: string | null;
    }>,
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO transcript_entries
         (transcript_path, session_id, uuid, parent_uuid, line_index, kind, tool_use_id, tool_name, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAll = this.db.transaction(() => {
      for (const e of entries) {
        stmt.run(
          path,
          sessionId,
          e.uuid,
          e.parent_uuid,
          e.line_index,
          e.kind,
          e.tool_use_id,
          e.tool_name,
          e.text,
        );
      }
    });
    insertAll();
  }

  transcriptEntriesByUuid(path: string, uuid: string): Array<{
    uuid: string;
    parent_uuid: string | null;
    line_index: number;
    kind: "text" | "thinking" | "tool_use" | "other";
    tool_use_id: string | null;
    tool_name: string | null;
    text: string | null;
  }> {
    return this.db
      .prepare("SELECT * FROM transcript_entries WHERE transcript_path = ? AND uuid = ?")
      .all(path, uuid) as never;
  }

  upsertToolIntent(input: {
    session_id: string;
    tool_use_id: string;
    transcript_pos: number;
    intent: string | null;
    intent_source: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tool_intents (session_id, tool_use_id, transcript_pos, intent, intent_source)
         VALUES (@session_id, @tool_use_id, @transcript_pos, @intent, @intent_source)
         ON CONFLICT(session_id, tool_use_id) DO UPDATE SET
           transcript_pos = excluded.transcript_pos,
           intent         = excluded.intent,
           intent_source  = excluded.intent_source`,
      )
      .run(input);
  }

  toolIntents(sessionId: string): Array<{
    tool_use_id: string;
    transcript_pos: number;
    intent: string | null;
    intent_source: "text" | "thinking" | null;
  }> {
    return this.db
      .prepare(
        `SELECT tool_use_id, transcript_pos, intent, intent_source
         FROM tool_intents WHERE session_id = ? ORDER BY transcript_pos`,
      )
      .all(sessionId) as never;
  }

  /**
   * Picker rows: enough to show and rank sessions without loading their events.
   * `median_gap_ms` feeds the idle half of the three-state verdict, which is
   * computed by the consumer — this only supplies the input.
   */
  sessionSummaries(limit = 50): unknown[] {
    const rows = this.db
      .prepare(
        `SELECT s.session_id, s.cwd, s.started_at, s.last_event_at, s.last_event_at_ms,
                s.stop_received, s.session_end_received,
                CASE WHEN s.stop_received = 1 OR s.session_end_received = 1 THEN 1 ELSE 0 END
                  AS explicit_end_received,
                (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS event_count
         FROM sessions s
         ORDER BY COALESCE(s.last_event_at_ms, 0) DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;

    const promptStmt = this.db.prepare(
      `SELECT summary FROM events
       WHERE session_id = ? AND hook_event_name = 'UserPromptSubmit'
       ORDER BY seq LIMIT 1`,
    );
    const filesStmt = this.db.prepare(
      `SELECT COUNT(DISTINCT tool_use_id) AS n FROM events
       WHERE session_id = ? AND hook_event_name = 'PreToolUse'
         AND tool_name IN ('Edit', 'Write', 'NotebookEdit')`,
    );
    const gapsStmt = this.db.prepare(
      "SELECT received_at_ms FROM events WHERE session_id = ? ORDER BY seq",
    );

    return rows.map((r) => {
      const id = r.session_id as string;
      const times = (gapsStmt.all(id) as Array<{ received_at_ms: number }>).map(
        (t) => t.received_at_ms,
      );
      const gaps: number[] = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
      gaps.sort((a, b) => a - b);
      const median = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 0;

      return {
        ...r,
        title: (promptStmt.get(id) as { summary?: string } | undefined)?.summary ?? null,
        files_touched: (filesStmt.get(id) as { n: number }).n,
        median_gap_ms: median,
      };
    });
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

  // ---- Phase 2: code graph ----

  /**
   * Replace the entire stored graph in one transaction. There is no partial
   * update: either the new graph fully replaces the old one, or (on any error)
   * the old one is untouched — never a half-written mix of two extractions.
   */
  replaceCodeGraph(input: {
    graph: CodeGraph;
    repoRoot: string;
    extractionMode: "full" | "incremental";
    wallMs: number;
    droppedInferredCount: number;
    contentHashes: Map<string, string>;
  }): void {
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM code_edges; DELETE FROM code_nodes; DELETE FROM code_graph_meta;");

      const insertNode = this.db.prepare(
        "INSERT INTO code_nodes (id, file_path, content_hash) VALUES (?, ?, ?)",
      );
      for (const n of input.graph.nodes) {
        insertNode.run(n.id, n.filePath, input.contentHashes.get(n.filePath) ?? null);
      }

      const insertEdge = this.db.prepare(
        "INSERT OR IGNORE INTO code_edges (from_id, to_id, kind, source) VALUES (?, ?, ?, ?)",
      );
      for (const e of input.graph.edges) {
        insertEdge.run(e.from, e.to, e.kind, e.source);
      }

      this.db
        .prepare(
          `INSERT INTO code_graph_meta
             (id, repo_root, extracted_at, built_at_commit, extraction_mode, wall_ms, node_count, edge_count, dropped_inferred_count)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.repoRoot,
          input.graph.extractedAt,
          input.graph.builtAtCommit,
          input.extractionMode,
          Math.round(input.wallMs),
          input.graph.nodes.length,
          input.graph.edges.length,
          input.droppedInferredCount,
        );
    });
    tx();
  }

  codeGraphMeta(): CodeGraphMetaRow | null {
    return (this.db.prepare("SELECT * FROM code_graph_meta WHERE id = 1").get() as
      | CodeGraphMetaRow
      | undefined) ?? null;
  }

  codeGraph(): { nodes: CodeNode[]; edges: CodeEdge[] } {
    const nodes = (
      this.db.prepare("SELECT id, file_path FROM code_nodes").all() as Array<{
        id: string;
        file_path: string;
      }>
    ).map((n) => ({ id: n.id, kind: "file" as const, label: n.file_path, filePath: n.file_path }));

    const edges = (
      this.db.prepare("SELECT from_id, to_id, kind, source FROM code_edges").all() as Array<{
        from_id: string;
        to_id: string;
        kind: string;
        source: string;
      }>
    ).map((e) => ({
      from: e.from_id,
      to: e.to_id,
      kind: e.kind as "imports",
      source: e.source as "graphify-extracted",
    }));

    return { nodes, edges };
  }

  /** Content hashes recorded for the currently-stored graph, keyed by file path. */
  codeGraphContentHashes(): Map<string, string> {
    const rows = this.db
      .prepare("SELECT file_path, content_hash FROM code_nodes WHERE content_hash IS NOT NULL")
      .all() as Array<{ file_path: string; content_hash: string }>;
    return new Map(rows.map((r) => [r.file_path, r.content_hash]));
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
