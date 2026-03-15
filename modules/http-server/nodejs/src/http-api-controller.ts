import { Static, Type } from "@sinclair/typebox";
import { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Readable } from "stream";
import { pipeline } from "stream/promises";

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
  response: Type.Array(
    Type.Object({
      status: Type.Integer({ minimum: 100, maximum: 599 }),
      when: Type.Optional(Type.String()),
      mode: Type.Optional(Type.Union([Type.Literal("buffer"), Type.Literal("stream")])),
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
});
type HttpApiRouteManifest = Static<typeof HttpApiRouteManifest>;

const HttpApiManifest = Type.Object({
  routes: Type.Array(HttpApiRouteManifest),
});
type HttpApiManifest = Static<typeof HttpApiManifest>;

export async function register(_ctx: ControllerContext): Promise<void> {}

export type ResponseEntry = Static<
  (typeof HttpApiRouteManifest)["properties"]["response"]["items"]
>;

export async function dispatchResponse(
  response: ResponseEntry[],
  result: unknown,
  requestContext: Record<string, unknown>,
  moduleContext: { expandWith: (v: unknown, ctx: Record<string, unknown>) => unknown },
  validateSchema: (value: unknown, schema: unknown) => void,
  reply: FastifyReply,
): Promise<void> {
  let matched: ResponseEntry | undefined;
  let fallback: ResponseEntry | undefined;

  for (const entry of response) {
    if (!entry.when) {
      fallback ??= entry;
      continue;
    }
    const condition = moduleContext.expandWith(entry.when, { result, ...requestContext });
    if (condition === true) {
      matched = entry;
      break;
    }
  }

  const statusEntry = matched ?? fallback;
  if (!statusEntry) {
    reply.code(500);
    reply.send({ error: "InternalServerError", message: "No matching response status entry", status: 500 });
    return;
  }

  reply.code(statusEntry.status);

  if (statusEntry.headers) {
    const mappedHeaders = moduleContext.expandWith(statusEntry.headers, { result, ...requestContext }) as Record<string, unknown>;
    Object.entries(mappedHeaders).forEach(([key, value]) => reply.header(key, value as string));
  }

  if (statusEntry.mode === "stream") {
    reply.hijack();
    reply.raw.writeHead(statusEntry.status, reply.getHeaders() as Record<string, string>);
    await pipeline(result as Readable, reply.raw);
    return;
  }

  if (statusEntry.body !== undefined) {
    const mappedBody = moduleContext.expandWith(statusEntry.body, { result, ...requestContext });
    if (statusEntry.schema?.body) {
      validateSchema(mappedBody, statusEntry.schema.body);
    }
    reply.send(mappedBody);
    return;
  }

  reply.send(result);
}

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
    const handler = route.handler ? { ...resolveHandlerName(route.handler), inputs: (route.handler as any).inputs } : null;
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

    schema.response = route.response.reduce(
      (acc, entry) => {
        if (entry.schema?.body) {
          acc[entry.status] = entry.schema.body;
        } else if (entry.schema) {
          acc[entry.status] = {};
        }
        return acc;
      },
      {} as Record<number, any>,
    );

    app.route({
      method: route.request.method as any,
      url: translatedPath,
      schema,
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const requestContext = {
            request: {
              method: request.method,
              path: request.url,
              params: request.params || {},
              query: request.query || {},
              headers: normalizeHeaders(request.headers),
              body: request.body,
            },
          };
          const evaluatedInputs = handler?.inputs
            ? (this.ctx.moduleContext.expandWith(handler.inputs, requestContext) as Record<string, unknown>)
            : {};
          const result = handler
            ? await this.ctx.invoke(handler.kind, handler.name, {
                ...evaluatedInputs,
                ...requestContext,
              })
            : undefined;

          return dispatchResponse(
            route.response,
            result,
            requestContext,
            this.ctx.moduleContext,
            this.ctx.validateSchema.bind(this.ctx),
            reply,
          );
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
