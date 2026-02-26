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
  handler: Type.Optional(
    Type.Object({
      kind: Type.String(),
      name: Type.String(),
      inputs: Type.Optional(Type.Any()),
    }),
  ),
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
    // Register custom error handler for validation errors
    app.setErrorHandler((error, request, reply) => {
      const mappedError = convertFastifyValidationError(error);
      if (mappedError) {
        reply.code(400);
        return reply.send(mappedError);
      }
      // Let Fastify handle other errors normally
      throw error;
    });

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
          acc[status] = {};
          if (statusConfig.schema.query) {
            acc[status].querystring = statusConfig.schema.query;
          }
          if (statusConfig.schema.body) {
            acc[status].body = statusConfig.schema.body;
          }
          if (statusConfig.schema.headers) {
            acc[status].headers = statusConfig.schema.headers;
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
          // Normalize headers to lowercase
          const normalizedHeaders = normalizeHeaders(request.headers);

          // Construct standardized Telo request object
          const requestPayload = {
            method: request.method,
            path: request.url,
            params: request.params || {},
            query: request.query || {},
            headers: normalizedHeaders,
            body: request.body,
          };

          // Wrap in "request" object as per spec
          const teloRequestContext = { request: requestPayload };

          const result = handler
            ? await this.ctx.invoke(
                handler.kind,
                handler.name,
                resolveHandlerInputs(route.handler, teloRequestContext),
              )
            : undefined;

          const response = route.response;

          // Determine final status code
          let statusCode = response.status;
          if (typeof statusCode === "string") {
            statusCode = this.ctx.expandValue(statusCode, { result }) as number;
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
            const mappedHeaders = this.ctx.expandValue(statusConfig.headers, { result });
            Object.entries(mappedHeaders).forEach(([key, value]) => {
              reply.header(key, value as string);
            });
          }

          // Map and send response body if specified
          if (statusConfig.body !== undefined) {
            const mappedBody = this.ctx.expandValue(statusConfig.body, { result });

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

export async function create(
  resource: HttpApiManifest,
  ctx: ResourceContext,
): Promise<HttpServerApi> {
  ctx.validateSchema(resource, HttpApiManifest);
  return new HttpServerApi(ctx, resource);
}

function resolveHandlerName(handler: any): { kind: string; name: string } {
  if (typeof handler === "string") {
    const [kind, name] = handler.split("/");
    return { kind, name };
  }
  if (
    handler &&
    typeof handler === "object" &&
    typeof handler.name === "string" &&
    typeof handler.kind === "string"
  ) {
    return { name: handler.name, kind: handler.kind };
  }
  throw new Error("Unable to resolve handler");
}

function resolveHandlerInputs(handler: any, requestContext: Record<string, any>): any {
  if (typeof handler === "string") {
    return requestContext;
  }
  if (!handler || typeof handler !== "object") {
    return requestContext;
  }
  if (!handler.inputs) {
    return requestContext;
  }
  return resolveTemplateInputs(handler.inputs, requestContext);
}

function resolveTemplateInputs(value: any, context: Record<string, any>): any {
  if (typeof value === "string") {
    const match = value.match(/^\s*\$\{\{\s*([^}]+)\s*\}\}\s*$/);
    if (match) {
      return resolveTemplatePath(match[1], context);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateInputs(item, context));
  }
  if (value && typeof value === "object") {
    const resolved: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value)) {
      resolved[key] = resolveTemplateInputs(entry, context);
    }
    return resolved;
  }
  return value;
}

function resolveTemplatePath(pathExpression: string, context: Record<string, any>): any {
  const parts = pathExpression.trim().split(".").filter(Boolean);
  let current: any = context;
  for (const part of parts) {
    if (!current || (typeof current !== "object" && typeof current !== "function")) {
      return undefined;
    }
    current = current[part];
  }
  return current;
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
