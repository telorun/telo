import apiReference from "@scalar/fastify-api-reference";
import { type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { FastifyInstance } from "fastify";
import { normalizeMountPrefix } from "./mount-prefix.js";
import { installSpecServerUrlRewrite, specServerUrlIsPerRequest } from "./openapi-spec-servers.js";

type HttpReferenceResource = RuntimeResource & {
  title?: string;
  theme?: string;
};

/** Whether the server this mount was attached to registered an OpenAPI document.
 *  The same test the reference renderer makes before it would fall back to
 *  serving nothing. */
function hasOpenApiDocument(app: FastifyInstance): boolean {
  return (
    app.hasPlugin("@fastify/swagger") &&
    typeof (app as unknown as { swagger?: unknown }).swagger === "function"
  );
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
 */
class HttpReference implements ResourceInstance {
  private readonly title?: string;
  private readonly theme?: string;

  constructor(resource: HttpReferenceResource) {
    this.title = resource.title;
    this.theme = resource.theme;
  }

  async init() {}

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
    // Scalar drops a trailing slash from its route prefix, so a reference mounted
    // at the root serves `/openapi.json` rather than `//openapi.json`.
    const base = routePrefix === "/" ? "" : routePrefix;
    if (specServerUrlIsPerRequest(app)) {
      installSpecServerUrlRewrite(app, `${base}/openapi.json`);
    }
    const configuration: Record<string, unknown> = {};
    if (this.title !== undefined) configuration.pageTitle = this.title;
    if (this.theme !== undefined) configuration.theme = this.theme;
    app.register(apiReference, { routePrefix, configuration });
  }
}

export async function create(resource: HttpReferenceResource): Promise<ResourceInstance> {
  return new HttpReference(resource);
}
