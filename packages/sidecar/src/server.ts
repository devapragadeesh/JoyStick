import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, summarize, type Envelope } from "@joystick/shared";
import { config } from "./config.js";
import { Store } from "./db.js";
import { Broker } from "./sse.js";
import { startTailer, tailOnce } from "./transcript.js";
import { CodeGraphScheduler, isEditTrigger } from "./codegraph-triggers.js";
import { registerQaRoutes } from "./qa-routes.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface BuildOptions {
  store?: Store;
  logger?: boolean;
  /** Disabled in tests, which drive the tailer explicitly for determinism. */
  tail?: boolean;
  /** Disabled in tests, which drive graphify extraction explicitly. */
  codeGraph?: boolean;
}

export function buildServer(opts: BuildOptions = {}): FastifyInstance & {
  store: Store;
  broker: Broker;
} {
  const store = opts.store ?? new Store();
  const broker = new Broker();
  const codeGraphEnabled = opts.codeGraph !== false;
  const codeGraph = new CodeGraphScheduler(store, config.dataDir);

  const app = Fastify({
    logger: opts.logger ?? false,
    // Logging is off by default: hook payloads arrive from a local shim, not a
    // browser, and per-request logging would sit on the write path for nothing.
    // With `logger` false, request logging is already disabled.
    bodyLimit: config.maxPayloadBytes,
  });

  /**
   * Ingest.
   *
   * Persist first, respond immediately, derive later. The response is not
   * allowed to depend on anything that could be slow, because on the other end
   * of this socket is a process attached to the agent loop.
   */
  app.post("/events", async (request, reply) => {
    const receivedAtMs = Date.now();
    const result = classify(request.body);

    if (result.kind === "rejected") {
      // Malformed input is dropped rather than stored. The shim ignores the
      // status code either way; this exists so /events is honest under test.
      return reply.code(400).send();
    }

    const payload = result.envelope;
    const p = payload as Record<string, unknown>;

    const row = store.insertEvent({
      session_id: payload.session_id,
      hook_event_name: payload.hook_event_name,
      tool_name: asString(p.tool_name),
      tool_use_id: asString(p.tool_use_id),
      agent_id: asString(p.agent_id),
      agent_type: asString(p.agent_type),
      prompt_id: asString(p.prompt_id),
      summary: summarize(payload),
      known: result.kind === "known",
      raw: JSON.stringify(request.body),
      received_at_ms: receivedAtMs,
    });

    trackSession(store, payload, receivedAtMs);
    store.touchSession({
      session_id: payload.session_id,
      hook_event_name: payload.hook_event_name,
      received_at_ms: receivedAtMs,
    });

    reply.code(204).send();

    // Everything past the response is off the critical path.
    setImmediate(() => broker.publish(row));

    // graphify triggers only from here — never its own hook, never its own
    // schedule. Both branches are fire-and-forget: the response already went
    // out, and CodeGraphScheduler's own methods never block or throw upward.
    if (codeGraphEnabled) {
      const cwd = asString(p.cwd);
      if (cwd && payload.hook_event_name === "SessionStart") {
        codeGraph.ensureInitialGraph(cwd);
      } else if (cwd && isEditTrigger(payload.hook_event_name, asString(p.tool_name))) {
        codeGraph.notifyEdit(cwd);
      }
    }
  });

  app.get("/health", async () => ({
    ok: true,
    port: config.port,
    db: config.dbPath,
    subscribers: broker.size,
    pid: process.pid,
  }));

  app.get("/stream", (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    broker.subscribe(reply);
  });

  app.get("/api/events", async (request) => {
    const q = request.query as { limit?: string; session_id?: string };
    const limit = Math.min(Number(q.limit) || 200, 2000);
    return store.recentEvents(limit, q.session_id);
  });

  app.get("/api/sessions", async () => store.sessionSummaries());

  /**
   * Transcript-derived intent and position. Separate from /api/events because
   * it lags: a step renders from its hook payload first and gains these later.
   */
  app.get("/api/intents", async (request) => {
    const q = request.query as { session_id?: string };
    return q.session_id ? store.toolIntents(q.session_id) : [];
  });

  /** Force a tailer pass. Used by tests and by the panel on demand. */
  app.post("/api/tail", async () => ({ tailed: tailOnce(store) }));

  /**
   * Raw liveness facts. Deliberately does not say whether a session ended —
   * that verdict needs an idle threshold and belongs to the consumer.
   */
  app.get("/api/liveness", async (request) => {
    const q = request.query as { session_id?: string };
    return store.liveness(q.session_id);
  });

  /**
   * Running check on the FIFO-adjacency assumption behind subagent attribution.
   * A consistently zero unattributed rate is evidence the undocumented ordering
   * holds; a rising one is the early warning that it changed upstream.
   */
  app.get("/api/attribution", async (request) => {
    const q = request.query as { session_id?: string };
    return store.attributionStats(q.session_id);
  });

  /**
   * The static architecture map: file nodes and EXTRACTED-only import edges.
   * Never includes an INFERRED edge — filtered out before storage, not here.
   */
  app.get("/api/codegraph", async () => ({
    meta: store.codeGraphMeta(),
    ...store.codeGraph(),
  }));

  /** Force a graphify extraction. Used by tests and the panel's manual refresh. */
  app.post("/api/codegraph/extract", async (request) => {
    const q = request.query as { repo_root?: string };
    const repoRoot = q.repo_root ?? process.cwd();
    codeGraph.forceExtraction(repoRoot);
    return { triggered: true, repoRoot };
  });

  registerQaRoutes(app, store);

  // The built panel, when present. In development the panel runs under Vite on
  // its own port and proxies here instead.
  const panelDist = join(here, "..", "..", "panel", "dist");
  if (existsSync(panelDist)) {
    app.register(fastifyStatic, { root: panelDist });
  }

  const heartbeat = setInterval(() => broker.heartbeat(), 25_000);
  heartbeat.unref();

  const tailer = opts.tail === false ? null : startTailer(store);

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    tailer?.stop();
    codeGraph.stop();
    broker.closeAll();
  });

  return Object.assign(app, { store, broker });
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function trackSession(store: Store, payload: Envelope, receivedAtMs: number): void {
  const p = payload as Record<string, unknown>;
  const at = new Date(receivedAtMs).toISOString();

  // Any event can be the first one we see for a session — the sidecar may have
  // started mid-session, or SessionStart may simply have lost the race.
  store.upsertSession({
    session_id: payload.session_id,
    cwd: asString(p.cwd),
    transcript_path: asString(p.transcript_path),
    source: payload.hook_event_name === "SessionStart" ? asString(p.source) : null,
    started_at: at,
  });

  if (payload.hook_event_name === "SessionEnd") {
    store.endSession(payload.session_id, asString(p.reason), at);
  }
}
