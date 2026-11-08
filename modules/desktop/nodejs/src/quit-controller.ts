import type { ResourceContext, ResourceManifest } from "@telorun/sdk";
import { acquireHost } from "./host-session.js";

export const Quit = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: ResourceManifest, ctx: ResourceContext) {
    return {
      async invoke() {
        const lease = await acquireHost(ctx, "/host");
        try {
          await lease.connection.request("Host.Quit", {});
        } finally {
          lease.release();
        }
        return {};
      },
      snapshot: () => ({}),
    };
  },
};
