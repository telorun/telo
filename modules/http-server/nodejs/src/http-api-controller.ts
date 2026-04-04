import { Static, Type } from "@sinclair/typebox";
import {
  ControllerContext,
  Invocable,
  KindRef,
  Ref,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
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
  handler: Type.Optional(Type.Unsafe<KindRef<Invocable>>(Ref("kernel#Invocable"))),
  inputs: Type.Optional(Type.Record(Type.String(), Type.Any())),
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
    reply.send({
      error: "InternalServerError",
      message: "No matching response status entry",
      status: 500,
    });
    return;
  }

  reply.code(statusEntry.status);

  if (statusEntry.headers) {
    const mappedHeaders = moduleContext.expandWith(statusEntry.headers, {
      result,
      ...requestContext,
    }) as Record<string, unknown>;
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
    // After Phase 5 injection, KindRef<Invocable> is replaced with the live Invocable instance.
    const handler = route.handler as unknown as Invocable | undefined;
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
          const invokeInput: Record<string, any> = route.inputs
            ? (this.ctx.moduleContext.expandWith(route.inputs, requestContext) as any)
            : requestContext;
          const result = handler ? await handler.invoke(invokeInput) : undefined;

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
  ctx.validateSchema(resource, HttpApiManifest);
  return new HttpServerApi(ctx, resource);
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
