import type { FastifyInstance, FastifyPluginAsync } from "fastify";

/** Liveness. Returns the runner's own version, supplied by the concrete runner
 *  (each runner package has its own version). */
export function healthRoute(version: string): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.get("/v1/health", async () => ({ ok: true, version }));
  };
}
