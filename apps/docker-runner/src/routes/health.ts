import type { FastifyInstance } from "fastify";

import packageJson from "../../package.json" with { type: "json" };

const VERSION: string = packageJson.version;

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get("/v1/health", async () => ({ ok: true, version: VERSION }));
}
