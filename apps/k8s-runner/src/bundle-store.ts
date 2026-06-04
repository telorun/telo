import { randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { RunBundle } from "@telorun/runner-core";

import { makeBundleTarGz } from "./tar.js";

interface StoredBundle {
  token: string;
  tarGz: Buffer;
  evictTimer: NodeJS.Timeout;
}

/** Staged bundles are dropped after this long even if never fetched, so a
 *  stuck/never-started Pod can't grow the store unbounded. */
const STAGING_TTL_MS = 5 * 60 * 1000;

/**
 * Holds session bundles in memory and serves them over a tokenized,
 * cluster-internal URL the session initContainer fetches once. The per-session
 * unguessable token prevents one session from reading another's bundle; the
 * entry is dropped after first fetch (or on session removal).
 */
export class BundleStore {
  private readonly bundles = new Map<string, StoredBundle>();

  constructor(private readonly selfUrl: string) {}

  /** Stages a bundle and returns the URL the initContainer should fetch. */
  async stage(sessionId: string, bundle: RunBundle): Promise<string> {
    this.drop(sessionId);
    const token = randomBytes(24).toString("hex");
    const tarGz = await makeBundleTarGz(bundle);
    const evictTimer = setTimeout(() => this.bundles.delete(sessionId), STAGING_TTL_MS);
    evictTimer.unref?.();
    this.bundles.set(sessionId, { token, tarGz, evictTimer });
    return `${this.selfUrl}/internal/bundles/${sessionId}?token=${token}`;
  }

  drop(sessionId: string): void {
    const existing = this.bundles.get(sessionId);
    if (existing) clearTimeout(existing.evictTimer);
    this.bundles.delete(sessionId);
  }

  private take(sessionId: string, token: string): Buffer | null {
    const stored = this.bundles.get(sessionId);
    if (!stored) return null;
    if (!constantTimeEqual(stored.token, token)) return null;
    // Single-use: drop after a successful authenticated fetch.
    this.drop(sessionId);
    return stored.tarGz;
  }

  /** Registers `GET /internal/bundles/:id` on the runner's Fastify app. */
  registerRoute(app: FastifyInstance): void {
    app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
      "/internal/bundles/:id",
      async (req, reply) => {
        const token = req.query.token ?? "";
        const tarGz = this.take(req.params.id, token);
        if (!tarGz) {
          reply.code(404).send({ error: "not_found" });
          return;
        }
        reply
          .header("content-type", "application/gzip")
          .header("cache-control", "no-store")
          .send(tarGz);
      },
    );
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return timingSafeEqual(ab, bb);
}
