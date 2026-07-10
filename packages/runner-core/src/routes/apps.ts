import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { RunnerBackend } from "../backend.js";
import type { ResolvedRunnerApp } from "../config.js";
import type { PortMapping, RunnerTerms } from "../contract.js";
import type { SessionRegistry } from "../session/registry.js";
import { enforceTerms, portsSchema, startWorkloadSession } from "./session-start.js";

export interface AppsRouteDeps {
  backend: RunnerBackend;
  registry: SessionRegistry;
  /** The runner's own default registry URL, surfaced to the workload as
   *  TELO_REGISTRY_URL when the request doesn't override it. */
  defaultRegistryUrl?: string;
  /** Terms gate shared with `POST /v1/sessions` — app sessions execute on the
   *  operator's infrastructure just like runs, so they ride the same 428. */
  terms?: RunnerTerms;
  /** Operator-predefined applications launchable by name. The catalog is the
   *  whole gate: the client picks a name, never an image, and the operator env
   *  is injected server-side. */
  apps?: Record<string, ResolvedRunnerApp>;
}

interface StartAppSessionBody {
  env?: Record<string, string>;
  ports?: PortMapping[];
  inspect?: boolean;
}

const startAppBodySchema = {
  type: "object",
  properties: {
    env: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    ports: portsSchema,
    inspect: { type: "boolean" },
  },
} as const;

/**
 * Creation door for operator-predefined app sessions. A client launches an app
 * by name; the runner resolves the image and injects the app's operator env
 * from the catalog (`RUNNER_APPS`). The created session lives in the SAME
 * session collection as bundle sessions — the 201 carries the shared
 * `/v1/sessions/:id/events` stream URL, and status/DELETE/io are served by the
 * sessions routes.
 */
export function appsRoute(deps: AppsRouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.post<{ Params: { name: string }; Body: StartAppSessionBody }>(
      "/v1/apps/:name/sessions",
      { schema: { body: startAppBodySchema } },
      async (req, reply) => {
        // Resolve the app before the terms gate: an unknown name is a 404
        // regardless of terms (there's no workload to gate), and the catalog is
        // already public on /v1/capabilities, so this leaks nothing.
        const appEntry = deps.apps?.[req.params.name];
        if (!appEntry) {
          const offered = Object.keys(deps.apps ?? {});
          reply.code(404).send({
            error: "unknown_app",
            message:
              `app '${req.params.name}' is not offered by this runner` +
              (offered.length > 0
                ? ` — offered apps: ${offered.join(", ")}`
                : " — it offers no predefined applications") +
              " (see /v1/capabilities).",
          });
          return;
        }

        if (!enforceTerms(req, reply, deps.terms)) return;

        // Drop client-supplied values for any env key the catalog defines (a
        // client must never override operator-held values, which include
        // secrets), then inject the operator's values.
        const clientEnv = req.body?.env ?? {};
        const env = {
          ...Object.fromEntries(
            Object.entries(clientEnv).filter(([key]) => !(key in appEntry.env)),
          ),
          ...appEntry.env,
        };

        return startWorkloadSession(
          app,
          deps,
          {
            // Self-contained image — no bundle to deliver; the entry path is an
            // unused placeholder so the backend spec stays total.
            bundle: { entryRelativePath: "telo.yaml", files: [] },
            entryRelativePath: "telo.yaml",
            env,
            ports: req.body?.ports ?? [],
            config: { image: appEntry.image, pullPolicy: appEntry.pullPolicy },
            selfContained: true,
            inspect: req.body?.inspect ?? false,
          },
          reply,
        );
      },
    );
  };
}
