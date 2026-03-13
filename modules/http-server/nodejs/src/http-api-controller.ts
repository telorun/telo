import { Static, Type } from "@sinclair/typebox";
import { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const HttpApiRouteManifest = Type.Object({
  request: Type.Object({
    path: Type.String(),
    method: Type.String(),
    schema: Type.Optional(
      Type.Object({
        params: Type.Optional(Type.Any()),
        query: Type.Optional(Type.Any()),
        body: Type.Optional(Type.Any()),
        headers: Type.Optional(Type.Any()),
      }),
    ),
  }),
  handler: Type.Optional(Type.Any()), // Any handler shape is allowed - will be processed in create()
  response: Type.Object({
    status: Type.Union([Type.Number({ minimum: 100, maximum: 599 }), Type.String()]),
    statuses: Type.Record(
      Type.String(),
      Type.Object({
        schema: Type.Optional(
          Type.Object({
            query: Type.Optional(Type.Any()),
            body: Type.Optional(Type.Any()),
            headers: Type.Optional(Type.Any()),
          }),
        ),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        body: Type.Optional(Type.Any()),
      }),
    ),
  }),
});
type HttpApiRouteManifest = Static<typeof HttpApiRouteManifest>;

const HttpApiManifest = Type.Object({
  routes: Type.Array(HttpApiRouteManifest),
});
type HttpApiManifest = Static<typeof HttpApiManifest>;

export async function register(ctx: ControllerContext): Promise<void> {}

export class HttpServerApi implements ResourceInstance {
  constructor(
    private readonly ctx: ResourceContext,
    readonly manifest: HttpApiManifest,
  ) {}

  async init() {}

  register(app: FastifyInstance, prefix = "") {
    if (prefix) {
      app.register(
        async (scoped) => {
          this.registerRoutes(scoped);
        },
        { prefix },
      );
    } else {
      this.registerRoutes(app);
    }
  }

  private registerRoutes(app: FastifyInstance) {
    const routes = this.manifest.routes || [];
    for (const route of routes) {
      this.registerRoute(app, route);
    }
  }

  private registerRoute(app: FastifyInstance, route: HttpApiRouteManifest) {
    const handler = route.handler ? resolveHandlerName(route.handler) : null;
    const translatedPath = translateOpenApiPath(route.request.path);

    const schema: any = {
      response: {},
    };

    if (route.request.schema?.query) {
      schema.querystring = route.request.schema?.query;
    }
    if (route.request.schema?.params) {
      schema.params = route.request.schema?.params;
    }
    if (route.request.schema?.body) {
      schema.body = route.request.schema?.body;
    }
    if (route.request.schema?.headers) {
      schema.headers = route.request.schema?.headers;
    }

    schema.response = Object.keys(route.response.statuses).reduce(
      (acc, status) => {
        const statusConfig = route.response.statuses[status];
        if (statusConfig.schema) {
          if (statusConfig.schema.body) {
            acc[status] = statusConfig.schema.body;
          } else {
            acc[status] = {};
          }
        }
        return acc;
      },
      {} as Record<string, any>,
    );

    app.route({
      method: route.request.method as any,
      url: translatedPath,
      schema,
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const result = handler
            ? await this.ctx.invoke(handler.kind, handler.name, {
                request: {
                  method: request.method,
                  path: request.url,
                  params: request.params || {},
                  query: request.query || {},
                  headers: normalizeHeaders(request.headers),
                  body: request.body,
                },
              })
            : undefined;

          const response = route.response;

          // Determine final status code
          let statusCode = response.status;
          if (typeof statusCode === "string") {
            statusCode = this.ctx.moduleContext.expandWith(statusCode, { result }) as number;
          }

          // Convert status to string for lookup
          const statusKey = String(statusCode);
          const statusConfig = response.statuses[statusKey];

          if (!statusConfig) {
            reply.code(500);
            return reply.send({
              error: "InternalServerError",
              message: "Response status configuration not found",
              status: 500,
            });
          }

          // Set HTTP status code
          reply.code(statusCode as number);

          // Map and set response headers if specified
          if (statusConfig.headers) {
            const mappedHeaders = this.ctx.moduleContext.expandWith(statusConfig.headers, { result }) as Record<string, unknown>;
            Object.entries(mappedHeaders).forEach(([key, value]) => {
              reply.header(key, value as string);
            });
          }

          // Map and send response body if specified
          if (statusConfig.body !== undefined) {
            const mappedBody = this.ctx.moduleContext.expandWith(statusConfig.body, { result });

            // Validate response body if schema is specified
            if (statusConfig.schema && statusConfig.schema.body) {
              this.ctx.validateSchema(mappedBody, statusConfig.schema.body);
            }

            return reply.send(mappedBody);
          }

          // No body mapping, send result as-is
          return reply.send(result);
        } catch (error) {
          // Let the error handler deal with all errors
          throw error;
        }
      },
    });
  }
}

export async function create(resource: any, ctx: ResourceContext): Promise<HttpServerApi> {
  // First validate with a permissive schema (handler can be any shape)
  ctx.validateSchema(resource, HttpApiManifest);
  // Process routes and register unnamed handlers as child resources
  let handlerCounter = 0;
  const processedRoutes = (resource.routes || []).map((route: any) => {
    if (!route.handler) {
      return route;
    }

    // Check if handler is unnamed (inline handler)
    if (typeof route.handler === "object" && !route.handler.name) {
      // Use resolveChildren to register the unnamed handler and get its normalized reference
      const resolvedHandler = ctx.resolveChildren(route.handler, `__handler_${handlerCounter++}`);

      // Return route with the resolved handler reference
      return {
        ...route,
        handler: {
          kind: resolvedHandler.kind,
          name: resolvedHandler.name,
          inputs: route.handler.inputs,
        },
      };
    }

    return route;
  });

  // Create the API instance with processed routes
  const processedResource: HttpApiManifest = {
    ...resource,
    routes: processedRoutes,
  };

  return new HttpServerApi(ctx, processedResource);
}

function resolveHandlerName(handler: any): { kind: string; name: string } {
  if (typeof handler === "string") {
    const [kind, name] = handler.split("/");
    return { kind, name };
  }
  if (handler && typeof handler === "object" && typeof handler.kind === "string") {
    // name should always be present after create() processes the routes
    // but fallback gracefully if it's not
    const name = handler.name || `__unnamed_${Math.random().toString(36).slice(2, 9)}`;
    return { name, kind: handler.kind };
  }
  throw new Error("Unable to resolve handler - handler must have a 'kind' property");
}

/**
 * Translates OpenAPI path format {paramName} to Fastify format :paramName
 * Example: /api/v1/users/{userId} -> /api/v1/users/:userId
 */
function translateOpenApiPath(openApiPath: string): string {
  return openApiPath.replace(/{([a-zA-Z_][a-zA-Z0-9_]*)}/g, ":$1");
}

/**
 * Normalizes all header keys to lowercase as per Telo spec
 */
function normalizeHeaders(headers: Record<string, any>): Record<string, any> {
  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

/**
 * Legacy function - kept for compatibility but not used
 * Converts framework-specific validation errors to standardized Telo format
 * Returns null if the error is not a validation error
 */
function convertValidationError(error: any): Record<string, any> | null {
  // Check if this is a Fastify/AJV validation error
  if (!error || typeof error !== "object") {
    return null;
  }

  // Fastify validation errors have a statusCode of 400 and validation array
  if (error.statusCode === 400 && Array.isArray(error.validation)) {
    const details = error.validation.map((err: any) => {
      const path = err.instancePath ? err.instancePath.replace(/^\//, "").replace(/\//g, ".") : "";

      // Determine location from keyword/message context
      let location = "body"; // default
      if (err.keyword === "required" && err.params?.missingProperty) {
        location = determinLocationFromContext(err);
      } else {
        location = determinLocationFromContext(err);
      }

      return {
        location,
        path: path || err.params?.missingProperty || "",
        message: err.message || "Validation failed",
      };
    });

    return {
      error: "ValidationError",
      message: "Request validation failed",
      status: 400,
      details,
    };
  }

  return null;
}

/**
 * Helper to determine the location (body, query, params, headers) from validation error context
 */
function determinLocationFromContext(err: any): string {
  // AJV validation errors in Fastify include parent keyword context
  if (err.parentSchema && err.instancePath) {
    const path = err.instancePath;
    // This is a simplified check; in practice, Fastify provides better context
    // For now, default to "body" for general validation errors
    return "body";
  }
  return "body";
}
