import fastifyStatic from "@fastify/static";
import { type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

  constructor(resource: HttpStaticResource, ctx: ResourceContext) {
    this.root = resolveRoot(resource.root, ctx);
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

/** Resolve the asset root relative to the manifest that declared the resource, so
 *  the frontend ships co-located with the app (same pattern as mcp-client). */
function resolveRoot(root: string, ctx: ResourceContext): string {
  if (isAbsolute(root)) return root;
  const source = ctx.moduleContext.source;
  if (!source.startsWith("file://")) return resolve(root);
  const baseDir = dirname(fileURLToPath(source));
  return resolve(baseDir, root);
}

export async function create(
  resource: HttpStaticResource,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  return new HttpStatic(resource, ctx);
}
