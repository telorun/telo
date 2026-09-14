import { getHtmlDocument } from "@scalar/core/libs/html-rendering";
import { normalize, toJson, toYaml } from "@scalar/openapi-parser";
import { type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { normalizeMountPrefix } from "./mount-prefix.js";
import { installSpecServerUrlRewrite, specServerUrlIsPerRequest } from "./openapi-spec-servers.js";

type HttpReferenceResource = RuntimeResource & {
  title?: string;
  theme?: string;
};

/** Scalar's browser bundle, staged from its npm release by the module's
 *  `sources:` block and shipped in the `assets` layer. It reads the page
 *  `getHtmlDocument` renders, so `@scalar/core` stays pinned to the version that
 *  release depends on (`tests/scalar-release.test.ts`). */
const BROWSER_BUNDLE = "./assets/scalar/standalone.js";
/** Where the page loads the bundle from, relative to the reference's prefix. */
const BUNDLE_ROUTE = "js/scalar.js";
/** The document download's filename, which Scalar's own plugin always sends. */
const DOWNLOAD_NAME = "spec";
const HIDDEN_FROM_DOCUMENT = { hide: true };

/** Whether the server this mount was attached to registered an OpenAPI document.
 *  The same test the reference renderer makes before it would fall back to
 *  serving nothing. */
function hasOpenApiDocument(app: FastifyInstance): boolean {
  return (
    app.hasPlugin("@fastify/swagger") &&
    typeof (app as unknown as { swagger?: unknown }).swagger === "function"
  );
}

function ignoresTrailingSlash(app: FastifyInstance): boolean {
  const config = app.initialConfig as {
    ignoreTrailingSlash?: boolean;
    routerOptions?: { ignoreTrailingSlash?: boolean };
  };
  return config.routerOptions?.ignoreTrailingSlash === true || config.ignoreTrailingSlash === true;
}

/**
 * The API reference: the server's OpenAPI document rendered as a browsable page,
 * plus the document itself at `<prefix>/openapi.json` and `<prefix>/openapi.yaml`.
 *
 * A mount rather than a fixed `/reference` route on the server, so the prefix is
 * the author's and the docs are one entry in `mounts:` — which is what lets a
 * `when:` leave them out of a production deployment. The document itself is still
 * the server's: `@fastify/swagger` collects a route's schema through an `onRoute`
 * hook in the encapsulation context it was registered in, so it has to be at the
 * root scope before any mount registers, and only the RENDERING can move here.
 *
 * The routes are registered here rather than through Scalar's Fastify plugin,
 * which reads the browser bundle from beside its own file — a location a bundled
 * controller does not have. The bundle is the module's own asset instead.
 */
class HttpReference implements ResourceInstance {
  private readonly title?: string;
  private readonly theme?: string;
  private bundle?: string;

  constructor(
    resource: HttpReferenceResource,
    private readonly ctx: ResourceContext,
  ) {
    this.title = resource.title;
    this.theme = resource.theme;
  }

  async init() {
    const uri = await this.ctx.resolveControllerFile(BROWSER_BUNDLE);
    this.bundle = await readFile(fileURLToPath(uri), "utf8");
  }

  register(app: FastifyInstance, prefix = ""): void {
    const routePrefix = normalizeMountPrefix(prefix);
    if (!hasOpenApiDocument(app)) {
      throw new Error(
        `Http.Reference mounted at '${routePrefix}' has nothing to render: the Http.Server ` +
          `it is mounted on declares no \`openapi:\` block, so no OpenAPI document is ` +
          `collected. Add one to the server:\n\n` +
          `  openapi:\n    info:\n      title: My API\n      version: 1.0.0`,
      );
    }
    const bundle = this.bundle;
    if (bundle === undefined) {
      throw new Error(`Http.Reference mounted at '${routePrefix}' was registered before init().`);
    }
    // A reference mounted at the root serves `/openapi.json` rather than
    // `//openapi.json`.
    const base = routePrefix === "/" ? "" : routePrefix;
    if (specServerUrlIsPerRequest(app)) {
      installSpecServerUrlRewrite(app, `${base}/openapi.json`);
    }
    const configuration: Record<string, unknown> = { _integration: "fastify" };
    if (this.title !== undefined) configuration.pageTitle = this.title;
    if (this.theme !== undefined) configuration.theme = this.theme;

    const withSwagger = app as unknown as { swagger(): Record<string, unknown> };
    const document = () => normalize(withSwagger.swagger()) as Record<string, unknown>;

    app.route({
      method: "GET",
      url: `${base}/openapi.json`,
      schema: HIDDEN_FROM_DOCUMENT,
      handler(_request, reply) {
        return reply
          .header("Content-Type", "application/json")
          .header("Content-Disposition", `filename=${DOWNLOAD_NAME}.json`)
          .header("Access-Control-Allow-Origin", "*")
          .header("Access-Control-Allow-Methods", "*")
          .send(JSON.parse(toJson(document())));
      },
    });
    app.route({
      method: "GET",
      url: `${base}/openapi.yaml`,
      schema: HIDDEN_FROM_DOCUMENT,
      handler(_request, reply) {
        return reply
          .header("Content-Type", "application/yaml")
          .header("Content-Disposition", `filename=${DOWNLOAD_NAME}.yaml`)
          .header("Access-Control-Allow-Origin", "*")
          .header("Access-Control-Allow-Methods", "*")
          .send(toYaml(document()));
      },
    });
    if (base !== "" && !ignoresTrailingSlash(app)) {
      app.route({
        method: "GET",
        url: base,
        schema: HIDDEN_FROM_DOCUMENT,
        handler(request, reply) {
          const url = new URL(request.url, `${request.protocol}://${request.hostname}`);
          return reply.redirect(`${url.pathname}/`, 301);
        },
      });
    }
    app.route({
      method: "GET",
      url: `${base}/`,
      schema: HIDDEN_FROM_DOCUMENT,
      handler(request, reply) {
        const url = new URL(request.url, `${request.protocol}://${request.hostname}`);
        if (!url.pathname.endsWith("/")) {
          return reply.redirect(`${url.pathname}/`, 301);
        }
        return reply
          .header("Content-Type", "text/html; charset=utf-8")
          // Relative, so the page works behind a proxy that rewrites the prefix.
          .send(getHtmlDocument({ cdn: BUNDLE_ROUTE, ...configuration, url: "./openapi.json" }));
      },
    });
    app.route({
      method: "GET",
      url: `${base}/${BUNDLE_ROUTE}`,
      schema: HIDDEN_FROM_DOCUMENT,
      handler(_request, reply) {
        return reply.header("Content-Type", "application/javascript; charset=utf-8").send(bundle);
      },
    });
  }
}

export async function create(
  resource: HttpReferenceResource,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  return new HttpReference(resource, ctx);
}
