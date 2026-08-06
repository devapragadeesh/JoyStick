import type { EventRow } from "@joystick/shared";
import type { FastifyReply } from "fastify";

/**
 * Fan-out to connected panels.
 *
 * Broadcasting is best-effort and never blocks the write path: /events persists
 * first and returns 204, and only then are subscribers told. A slow or dead
 * panel can lose messages; the panel backfills from /api/events on connect.
 */
export class Broker {
  private clients = new Set<FastifyReply>();

  subscribe(reply: FastifyReply): void {
    this.clients.add(reply);
    reply.raw.on("close", () => this.clients.delete(reply));
  }

  get size(): number {
    return this.clients.size;
  }

  publish(event: EventRow): void {
    if (this.clients.size === 0) return;
    // JSON.stringify cannot emit a bare newline outside a string literal, so
    // the payload is always a single SSE data line.
    const frame = `event: joystick\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.raw.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  heartbeat(): void {
    for (const client of this.clients) {
      try {
        client.raw.write(": ping\n\n");
      } catch {
        this.clients.delete(client);
      }
    }
  }

  closeAll(): void {
    for (const client of this.clients) {
      try {
        client.raw.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
  }
}
