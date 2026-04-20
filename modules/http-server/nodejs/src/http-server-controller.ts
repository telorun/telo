import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import apiReference from "@scalar/fastify-api-reference";
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
import {
  CatchEntry,
  dispatchCatches,
  dispatchReturns,
  HttpServerApi,
  ReturnEntry,
} from "./http-api-controller.js";

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
  logger?: boolean;
  cors?: CorsOptions;
  contentTypeParsers?: Array<{ contentType: string; parser?: Invocable }>;
  openapi?: {
    info: {
      title: string;
      version: string;
    };
  };
  mounts?: Array<{
    path?: string;
    type?: string;
  }>;
  notFoundHandler?: {
    invoke: KindRef<Invocable>;
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
    this.resolvedNotFoundHandler = resolvedNotFoundHandler;

    if (!this.port) {
      throw new Error("Http.Server port is required");
    }
    this.app = Fastify({
      logger: resource.logger,
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
    for (const { contentType, parser } of this.resource.contentTypeParsers ?? []) {
      if (parser) {
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
      await this.app.register(cors, {
        origin: this.resource.cors.origin,
        methods: this.resource.cors.methods,
        allowedHeaders: this.resource.cors.allowedHeaders,
        exposedHeaders: this.resource.cors.exposedHeaders,
        credentials: this.resource.cors.credentials,
        maxAge: this.resource.cors.maxAge,
        cacheControl: this.resource.cors.cacheControl,
        preflightContinue: this.resource.cors.preflightContinue,
        optionsSuccessStatus: this.resource.cors.optionsSuccessStatus,
        preflight: this.resource.cors.preflight,
        strictPreflight: this.resource.cors.strictPreflight,
        hideOptionsRoute: this.resource.cors.hideOptionsRoute,
      });
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
      const servers = [];
      // const routesByName = new Map<string, HttpRouteResource>();
      const mounts = this.resource.mounts || [];
      const prefixes = new Set();
      for (const mount of mounts) {
        prefixes.add(mount.path || "");
      }
      for (const prefix of prefixes) {
        servers.push({ url: this.baseUrl + prefix });
      }
      await this.app.register(swagger, {
        openapi: {
          openapi: "3.0.0",
          info: this.resource.openapi.info,
          servers,
        },
      });
      await this.app.register(apiReference, {
        routePrefix: "/reference",
      });
    }
  }

  private setupRoutes(): void {
    // const routesByName = new Map<string, HttpRouteResource>();
    const mounts = this.resource.mounts || [];
    // const resolveSchema = createSchemaResolver(this.ctx);
    for (const mount of mounts) {
      const type = mount.type || "";
      const { kind, name } = parseType(type);
      const prefix = mount.path || "";

      const api = this.ctx.moduleContext.getInstance(name) as unknown as HttpServerApi;

      if (!api) {
        throw new Error(`Failed to mount Http.Api at "${prefix}": ${type} not found`);
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

        let result: any;
        try {
          result = await this.ctx.invoke(handler.kind, handler.name, requestContext);
        } catch (err) {
          if (!isInvokeError(err)) throw err;
          return dispatchCatches(
            handler.catches,
            { code: err.code, message: err.message, data: err.data },
            requestContext,
            this.ctx.moduleContext,
            this.ctx.validateSchema.bind(this.ctx),
            reply,
          );
        }

        if (handler.returns) {
          return dispatchReturns(
            handler.returns,
            result,
            requestContext,
            this.ctx.moduleContext,
            this.ctx.validateSchema.bind(this.ctx),
            reply,
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
      inputs: (invoke as any)?.inputs ?? {},
      returns: resource.notFoundHandler.returns,
      catches: resource.notFoundHandler.catches,
    };
  }
  return new HttpServer(resource, ctx, resolvedNotFoundHandler);
}

function parseType(type: string): { kind: string; name: string } {
  const separator = type.lastIndexOf(".");
  if (separator <= 0 || separator === type.length - 1) {
    return { kind: "", name: "" };
  }
  return { kind: type.slice(0, separator), name: type.slice(separator + 1) };
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
