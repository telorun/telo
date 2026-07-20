import cors from "@fastify/cors";
import { createFastifyTeloLogger } from "./fastify-telo-logger.js";
import swagger from "@fastify/swagger";
import apiReference from "@scalar/fastify-api-reference";
import {
  CatchEntry,
  dispatchCatches,
  dispatchReturns,
  ReturnEntry,
} from "@telorun/http-dispatch";
import {
  isInvokeError,
  type Invocable,
  type KindRef,
  type ResourceContext,
  type ResourceInstance,
  type RuntimeResource,
} from "@telorun/sdk";
import addFormats from "ajv-formats";
import Fastify, { FastifyInstance } from "fastify";
import { fastifyReplySink } from "./fastify-reply-sink.js";

/** A mounted Telo.Mount instance (Http.Api, Mcp.HttpEndpoint, …). The kernel injects the
 *  live instance into a mount's `mount` slot (x-telo-ref "telo#Mount") — cross-module refs
 *  resolve to an imported library's exported mount — and every mountable exposes register(). */
interface Mountable {
  register(app: FastifyInstance, prefix: string): void | Promise<void>;
}

type CorsOptions = {
  origin?: string | boolean | string[];
  methods?: string | string[];
  allowedHeaders?: string | string[];
  exposedHeaders?: string | string[];
  credentials?: boolean;
  maxAge?: number;
  cacheControl?: number | string;
  preflightContinue?: boolean;
  optionsSuccessStatus?: number;
  preflight?: boolean;
  strictPreflight?: boolean;
  hideOptionsRoute?: boolean;
};

type HttpServerResource = RuntimeResource & {
  host?: string;
  port?: number;
  baseUrl?: string;
  trustForwardedHeaders?: boolean;
  trustProxy?: boolean | number;
  logger?: boolean;
  cors?: CorsOptions;
  contentTypeParsers?: Array<{ contentType: string; parser?: Invocable; stream?: boolean }>;
  openapi?: {
    info: {
      title: string;
      version: string;
    };
  };
  mounts?: Array<{
    path?: string;
    // x-telo-ref "telo#Mount": Phase 5 replaces this slot with the live mounted
    // instance (Http.Api, Mcp.HttpEndpoint, …), local or imported.
    mount?: Mountable;
  }>;
  notFoundHandler?: {
    invoke: KindRef<Invocable>;
    inputs?: Record<string, unknown>;
    returns?: ReturnEntry[];
    catches?: CatchEntry[];
  };
};

type ResolvedHandler = {
  kind: string;
  name: string;
  inputs: Record<string, any>;
  returns?: ReturnEntry[];
  catches?: CatchEntry[];
};

class HttpServer implements ResourceInstance {
  private releaseHold: (() => void) | null = null;
  private pluginsInitialized = false;
  private readonly app: FastifyInstance;
  private readonly host: string;
  private readonly port: number;
  private readonly baseUrl: string;
  private readonly trustForwardedHeaders: boolean;
  private readonly resource: HttpServerResource;
  private readonly ctx: ResourceContext;
  private readonly resolvedNotFoundHandler: ResolvedHandler | null;

  constructor(
    resource: HttpServerResource,
    ctx: ResourceContext,
    resolvedNotFoundHandler: ResolvedHandler | null = null,
  ) {
    this.resource = resource;
    this.ctx = ctx;
    this.host = resource.host || "0.0.0.0";
    this.port = Number(resource.port || 0);
    this.baseUrl = resource.baseUrl ?? `http://${this.host}:${this.port}`;
    this.trustForwardedHeaders = resource.trustForwardedHeaders === true;
    this.resolvedNotFoundHandler = resolvedNotFoundHandler;

    if (!this.port) {
      throw new Error("Http.Server port is required");
    }
    // `trustProxy` is the single Fastify knob behind both the forwarded
    // protocol/host (request.protocol/host) and the canonical client address
    // (request.ip). An explicit `trustProxy` (boolean / hop-count) wins; absent
    // it, the legacy `trustForwardedHeaders` boolean still applies.
    const trustProxy = resource.trustProxy ?? this.trustForwardedHeaders;
    this.app = Fastify({
      // §13.3: replacement, not bridging. Fastify's Pino instance is swapped for
      // a Telo-backed adapter, so request records are Telo records at the source
      // and inherit the root `logging:` block's level, encoding, redaction, and
      // sinks. `logger:` now means "enable request logging" rather than being a
      // raw Fastify passthrough.
      logger: resource.logger ? createFastifyTeloLogger(this.ctx.log) : false,
      trustProxy,
      ajv: { customOptions: { useDefaults: true }, plugins: [addFormats.default as any] },
    });
  }

  async init() {
    if (!this.pluginsInitialized) {
      await this.setupPlugins();
      this.pluginsInitialized = true;
    }
    this.setupRoutes();
  }

  private async setupPlugins() {
    for (const { contentType, parser, stream } of this.resource.contentTypeParsers ?? []) {
      if (stream) {
        // Raw passthrough: omit `parseAs` so Fastify hands the handler the
        // undrained request stream. The matching route wraps `request.body`
        // in a `Stream<Uint8Array>`. No buffering, no AJV — see http-api-controller.
        this.app.addContentTypeParser(contentType, (_req, payload, done) => {
          done(null, payload);
        });
      } else if (parser) {
        this.app.addContentTypeParser(
          contentType,
          { parseAs: "string" },
          async (_req, body, done) => {
            try {
              done(null, await parser.invoke({ body }));
            } catch (err) {
              done(err as Error, undefined);
            }
          },
        );
      } else {
        this.app.addContentTypeParser(contentType, { parseAs: "string" }, (_req, body, done) => {
          done(null, body);
        });
      }
    }

    if (this.resource.cors) {
      // Only forward the fields the manifest actually set. Spreading `undefined`
      // for an unset option overrides @fastify/cors's own defaults with
      // `undefined` — notably `preflight: undefined` disables the preflight 204
      // reply (its `OPTIONS *` handler then `callNotFound()`s → 404), which a
      // browser reports as "preflight … does not have HTTP ok status".
      const cfg = this.resource.cors;
      const corsOptions: Record<string, unknown> = {};
      for (const key of [
        "origin",
        "methods",
        "allowedHeaders",
        "exposedHeaders",
        "credentials",
        "maxAge",
        "cacheControl",
        "preflightContinue",
        "optionsSuccessStatus",
        "preflight",
        "strictPreflight",
        "hideOptionsRoute",
      ] as const) {
        if (cfg[key] !== undefined) corsOptions[key] = cfg[key];
      }
      await this.app.register(cors, corsOptions);
    }

    // Register custom error handler for validation errors
    this.app.setErrorHandler((error, request, reply) => {
      const mappedError = convertFastifyValidationError(error);
      if (mappedError) {
        reply.code(400);
        return reply.send(mappedError);
      }
      // Let Fastify handle other errors normally
      throw error;
    });
    if (this.resource.openapi) {
      // Each route is documented at its full `mount-prefix + path` (see
      // http-api-controller), so the server is a single origin, not one entry per
      // mount. Server URL precedence: an explicit `baseUrl` is an absolute, fixed
      // override; otherwise the URL is relative (`/`) so the doc is correct behind
      // any proxy/ingress/origin — the client resolves it against wherever the
      // reference was loaded.
      const servers = [{ url: this.resource.baseUrl ?? "/" }];
      await this.app.register(swagger, {
        openapi: {
          openapi: "3.0.0",
          info: this.resource.openapi.info,
          servers,
        },
      });
      const referencePrefix = "/reference";
      // `trustForwardedHeaders` (and no fixed baseUrl) upgrades the relative
      // default to absolute URLs built per-request from the now-trusted
      // X-Forwarded-* headers, so the served spec advertises the real proxy URL.
      if (this.trustForwardedHeaders && !this.resource.baseUrl) {
        // Couples to the Scalar plugin's default spec endpoint
        // (`<routePrefix>/openapi.json`); if it ever served the doc elsewhere the
        // rewrite would no-op and the relative default would still apply. The
        // `openapi-server-url` integration test guards this path.
        const specPath = `${referencePrefix}/openapi.json`;
        this.app.addHook("onSend", async (request, reply, payload) => {
          if (request.url.split("?")[0] !== specPath) return payload;
          const text =
            typeof payload === "string"
              ? payload
              : Buffer.isBuffer(payload)
                ? payload.toString("utf8")
                : null;
          if (text === null) return payload;
          try {
            const doc = JSON.parse(text);
            if (doc && typeof doc === "object" && Array.isArray(doc.servers)) {
              doc.servers = [{ url: `${request.protocol}://${request.host}` }];
              const out = JSON.stringify(doc);
              reply.header("content-length", Buffer.byteLength(out));
              return out;
            }
          } catch {
            // Not a JSON document we can rewrite — leave the response untouched.
          }
          return payload;
        });
      }
      await this.app.register(apiReference, {
        routePrefix: referencePrefix,
      });
    }
  }

  private setupRoutes(): void {
    // const routesByName = new Map<string, HttpRouteResource>();
    const mounts = this.resource.mounts || [];
    // const resolveSchema = createSchemaResolver(this.ctx);
    for (const mount of mounts) {
      const prefix = mount.path || "";
      // `mount.mount` is the live Telo.Mount instance injected by the kernel at Phase 5
      // (x-telo-ref "telo#Mount") — a same-module or imported-library mount, uniformly.
      const api = mount.mount;
      if (!api || typeof api.register !== "function") {
        throw new Error(
          `Failed to mount at "${prefix}": mount target did not resolve to a Telo.Mount instance`,
        );
      }
      api.register(this.app, prefix);
    }

    if (this.resolvedNotFoundHandler) {
      const handler = this.resolvedNotFoundHandler;
      this.app.setNotFoundHandler(async (request, reply) => {
        const normalizedHeaders: Record<string, any> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          normalizedHeaders[key.toLowerCase()] = value;
        }
        const requestContext = {
          request: {
            method: request.method,
            path: request.url,
            params: request.params || {},
            query: request.query || {},
            headers: normalizedHeaders,
            body: request.body,
          },
        };
        const acceptHeader = (
          (request.headers as Record<string, string | string[] | undefined>)["accept"] as
            | string
            | undefined
        )?.toString();

        const sink = fastifyReplySink(reply);

        // Expand the `inputs:` sibling template against the request context,
        // then pass the merged shape (spread for convenience + `inputs:` field
        // for handlers that read it explicitly) to the dispatch target. Same
        // contract Api.routes[*] uses. When no `inputs:` is declared, the
        // request context itself is forwarded so existing manifests that read
        // `request.*` directly continue to work.
        const resolvedInputs: Record<string, any> =
          handler.inputs && Object.keys(handler.inputs).length > 0
            ? ((this.ctx.moduleContext.expandWith(handler.inputs, requestContext) as any) ?? {})
            : requestContext;
        const invokeInput: Record<string, any> = {
          ...resolvedInputs,
          inputs: resolvedInputs,
        };

        let result: any;
        try {
          result = await this.ctx.invoke(handler.kind, handler.name, invokeInput);
        } catch (err) {
          if (!isInvokeError(err)) throw err;
          return dispatchCatches(
            handler.catches,
            { code: err.code, message: err.message, data: err.data },
            requestContext,
            acceptHeader,
            this.ctx.moduleContext,
            this.ctx.validateSchema.bind(this.ctx),
            sink,
          );
        }

        if (handler.returns) {
          return dispatchReturns(
            handler.returns,
            result,
            requestContext,
            acceptHeader,
            this.ctx.moduleContext,
            this.ctx.validateSchema.bind(this.ctx),
            sink,
          );
        }
        const status = result?.status ?? 200;
        reply.code(status);
        if (result?.headers) {
          Object.entries(result.headers).forEach(([key, value]) =>
            reply.header(key, value as string),
          );
        }
        return reply.send(result?.body ?? result);
      });
    }
  }

  async run(): Promise<void> {
    this.releaseHold = this.ctx.acquireHold();
    try {
      await this.app.listen({ host: this.host, port: this.port });
      await this.ctx.emitEvent(`${this.resource.metadata.name}.Listening`, {
        port: this.port,
        host: this.host,
        baseUrl: this.baseUrl,
        mounts: this.resource.mounts,
        openapi: this.resource.openapi,
      });
    } catch (error) {
      await this.app.close();
      if (this.releaseHold) {
        this.releaseHold();
        this.releaseHold = null;
      }
      throw error;
    }
  }

  async teardown(): Promise<void> {
    if (this.releaseHold) {
      this.releaseHold();
      this.releaseHold = null;
    }
    await this.app.close();
  }
}

export async function create(
  resource: HttpServerResource,
  ctx: ResourceContext,
): Promise<ResourceInstance | null> {
  let resolvedNotFoundHandler: ResolvedHandler | null = null;
  if (resource.notFoundHandler) {
    const invoke = resource.notFoundHandler.invoke as unknown;
    let kind = "";
    let name = "";
    if (typeof invoke === "object" && invoke !== null) {
      const resolved = ctx.resolveChildren(invoke);
      kind = resolved.kind;
      name = resolved.name;
    } else if (typeof invoke === "string") {
      // String form (schema oneOf: string | object) — resource name only.
      name = invoke;
    }
    resolvedNotFoundHandler = {
      kind,
      name,
      inputs: resource.notFoundHandler.inputs ?? {},
      returns: resource.notFoundHandler.returns,
      catches: resource.notFoundHandler.catches,
    };
  }
  return new HttpServer(resource, ctx, resolvedNotFoundHandler);
}

/**
 * Converts Fastify validation errors to standardized Telo format
 * Returns null if the error is not a validation error
 */
function convertFastifyValidationError(error: any): Record<string, any> | null {
  // Check if this is a Fastify validation error
  if (!error || typeof error !== "object" || error.code !== "FST_ERR_VALIDATION") {
    return null;
  }

  const message = error.message || "";
  const details = [];

  // Parse Fastify validation error message to extract location and field
  // Format examples:
  // "querystring must have required property 'name'"
  // "body must be object"
  // "params.userId must be string"

  let location = "body"; // default
  let fieldPath = "";
  let validationMessage = "Validation failed";

  // Try to extract location from message
  if (message.includes("querystring")) {
    location = "query";
  } else if (message.includes("params")) {
    location = "params";
  } else if (message.includes("headers")) {
    location = "headers";
  } else if (message.includes("body")) {
    location = "body";
  }

  // Extract field name from "must have required property 'fieldName'" pattern
  const requiredMatch = message.match(/must have required property '([^']+)'/);
  if (requiredMatch) {
    fieldPath = requiredMatch[1];
    validationMessage = `is a required property`;
  } else {
    // Extract field from "fieldName must be" pattern
    const fieldMatch = message.match(/^(?:querystring|body|params|headers)\.?(\w+)\s/);
    if (fieldMatch) {
      fieldPath = fieldMatch[1];
    }
    validationMessage = message
      .replace(/^(?:querystring|body|params|headers)\.?\w*\s/, "")
      .replace(" must ", " ");
  }

  if (fieldPath || message) {
    details.push({
      location,
      path: fieldPath,
      message: validationMessage,
    });
  }

  return {
    error: "ValidationError",
    message: "Request validation failed",
    status: 400,
    details,
  };
}
