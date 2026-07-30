import fastifyStatic from "@fastify/static";
import { type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type HttpStaticResource = RuntimeResource & {
  root: string;
  index?: string;
  spaFallback?: boolean;
  maxAge?: number;
  immutable?: boolean;
};

/** Collapse a mount prefix to a single leading slash with no trailing slash;
 *  an empty/`"/"` prefix becomes `"/"`. Unlike Http.Api (which returns `""` and
 *  concatenates the prefix onto each route path on the root app), this serves
 *  from an encapsulated `register({ prefix })`, which needs a non-empty prefix —
 *  hence root maps to `"/"`, not `""`. */
function normalizeMountPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, "");
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Serves a directory of static assets (a built SPA, plain HTML, images, …) as a
 *  Telo.Mount. Mirrors Http.Api's `register(app, prefix)` contract so it slots into
 *  Http.Server.mounts identically. Backed by @fastify/static, which handles MIME,
 *  ETag, conditional requests, and range requests. */
class HttpStatic implements ResourceInstance {
  private readonly root: string;
  private readonly index: string;
  private readonly spaFallback: boolean;
  private readonly maxAge?: number;
  private readonly immutable: boolean;

  constructor(resource: HttpStaticResource, root: string) {
    this.root = root;
    this.index = resource.index ?? "index.html";
    this.spaFallback = resource.spaFallback === true;
    this.maxAge = resource.maxAge;
    this.immutable = resource.immutable === true;
  }

  async init() {}

  register(app: FastifyInstance, prefix = ""): void {
    const mountPrefix = normalizeMountPrefix(prefix);
    const root = this.root;
    const index = this.index;
    const spaFallback = this.spaFallback;
    const cacheControl = this.maxAge != null;
    // @fastify/static takes maxAge in milliseconds; the manifest declares seconds.
    const maxAge = this.maxAge != null ? this.maxAge * 1000 : undefined;
    const immutable = this.immutable;

    // Encapsulated scope so the static plugin, its routes, and the SPA not-found
    // handler are confined to this mount's prefix and don't collide with sibling
    // mounts or the server-level notFoundHandler. `decorateReply: false` keeps
    // multiple static mounts from fighting over the shared `reply.sendFile`
    // decorator — the SPA fallback reads the index file directly instead.
    app.register(
      async (scope) => {
        await scope.register(fastifyStatic, {
          root,
          prefix: "/",
          index,
          // With spaFallback we want unmatched paths to fall through to the
          // not-found handler (client-side routing); the wildcard glob route
          // would otherwise 404 them itself.
          wildcard: !spaFallback,
          cacheControl,
          maxAge,
          immutable,
          decorateReply: false,
        });

        if (spaFallback) {
          const indexPath = join(root, index);
          // Deep-link/refresh navigations are the common path for a client-routed
          // SPA, so read the index once and serve the cached buffer — mirroring
          // the caching @fastify/static does for real files. (A build that swaps
          // index.html while the server runs isn't picked up, consistent with
          // @fastify/static's own behavior.)
          let indexHtml: Buffer | null = null;
          scope.setNotFoundHandler(async (_request, reply) => {
            if (indexHtml === null) indexHtml = await readFile(indexPath);
            return reply.type("text/html").send(indexHtml);
          });
        }
      },
      { prefix: mountPrefix },
    );
  }
}

/**
 * Resolve the asset root against the declaring module's own directory, so the
 * frontend ships co-located with the app.
 *
 * `ctx.resolveModuleFile` is the only correct way to do this: for a published
 * module the manifest URL is not where its payload lives, and it also materializes
 * the module's asset layer on first access. Deriving the directory from
 * `moduleContext.source` by hand silently fell back to the process working
 * directory for any non-`file://` module — serving the wrong files instead of
 * failing.
 */
async function resolveRoot(root: string, ctx: ResourceContext): Promise<string> {
  if (isAbsolute(root)) return root;
  // A directory reference: the trailing slash keeps URL resolution from treating
  // the last segment as a sibling file.
  // A module whose files cannot be located raises its own actionable error from
  // `resolveModuleFile` (naming republication), so this only guards a scheme that
  // resolved fine but is not servable from disk.
  const uri = await ctx.resolveModuleFile(root.endsWith("/") ? root : `${root}/`);
  if (!uri.startsWith("file://")) {
    throw new Error(
      `Http.Static root '${root}' resolved to '${uri}'. A static root must be a local ` +
        `directory, and this runtime can only serve files from one.`,
    );
  }
  // Strip the trailing separator the directory form introduced.
  return resolve(fileURLToPath(uri));
}

export async function create(
  resource: HttpStaticResource,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  return new HttpStatic(resource, await resolveRoot(resource.root, ctx));
}
