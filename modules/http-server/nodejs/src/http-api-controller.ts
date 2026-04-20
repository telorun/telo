import { Static, Type } from "@sinclair/typebox";
import {
  ControllerContext,
  Invocable,
  isInvokeError,
  KindRef,
  Ref,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Readable } from "stream";
import { pipeline } from "stream/promises";

const ReturnEntry = Type.Object({
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
});
type ReturnEntry = Static<typeof ReturnEntry>;

const CatchEntry = Type.Object({
  status: Type.Integer({ minimum: 100, maximum: 599 }),
  when: Type.Optional(Type.String()),
  schema: Type.Optional(
    Type.Object({
      body: Type.Optional(Type.Any()),
      headers: Type.Optional(Type.Any()),
    }),
  ),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  body: Type.Optional(Type.Any()),
});
type CatchEntry = Static<typeof CatchEntry>;

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
  handler: Type.Optional(Type.Unsafe<KindRef<Invocable>>(Ref("telo#Invocable"))),
  inputs: Type.Optional(Type.Record(Type.String(), Type.Any())),
  returns: Type.Array(ReturnEntry),
  catches: Type.Optional(Type.Array(CatchEntry)),
});
type HttpApiRouteManifest = Static<typeof HttpApiRouteManifest>;

const HttpApiManifest = Type.Object({
  routes: Type.Array(HttpApiRouteManifest),
});
type HttpApiManifest = Static<typeof HttpApiManifest>;

export async function register(_ctx: ControllerContext): Promise<void> {}

export type { ReturnEntry, CatchEntry };

type ModuleLikeContext = {
  expandWith: (v: unknown, ctx: Record<string, unknown>) => unknown;
};

type ValidateSchema = (value: unknown, schema: unknown) => void;

type HandlerRef = { kind: string; name: string };

/** Pick the first entry whose `when:` evaluates truthy, falling back to the
 *  first entry with no `when:` (the list's catch-all). */
function matchEntry<T extends { when?: string }>(
  entries: T[],
  celCtx: Record<string, unknown>,
  moduleContext: ModuleLikeContext,
): T | undefined {
  let fallback: T | undefined;
  for (const entry of entries) {
    if (!entry.when) {
      fallback ??= entry;
      continue;
    }
    if (moduleContext.expandWith(entry.when, celCtx) === true) return entry;
  }
  return fallback;
}

export async function dispatchReturns(
  returns: ReturnEntry[],
  result: unknown,
  requestContext: Record<string, unknown>,
  moduleContext: ModuleLikeContext,
  validateSchema: ValidateSchema,
  reply: FastifyReply,
): Promise<void> {
  const celCtx = { result, ...requestContext };
  const entry = matchEntry(returns, celCtx, moduleContext);

  if (!entry) {
    // Unreachable when the analyzer has run — every route's returns: list must
    // cover its handler's return values (explicit when: or catch-all). Hitting
    // this at runtime means something bypassed analysis; surface it loudly
    // via Fastify's error handler rather than quietly render a 500.
    throw new Error(
      "No matching returns entry for handler result — the route's returns: list must cover every return value (add a catch-all entry or widen a when: clause)",
    );
  }

  reply.code(entry.status);

  if (entry.headers) {
    const mappedHeaders = moduleContext.expandWith(entry.headers, celCtx) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(mappedHeaders)) {
      reply.header(key, value as string);
    }
  }

  if (entry.mode === "stream") {
    reply.hijack();
    reply.raw.writeHead(entry.status, reply.getHeaders() as Record<string, string>);
    await pipeline(result as Readable, reply.raw);
    return;
  }

  if (entry.body !== undefined) {
    const mappedBody = moduleContext.expandWith(entry.body, celCtx);
    if (entry.schema?.body) validateSchema(mappedBody, entry.schema.body);
    reply.send(mappedBody);
    return;
  }

  reply.send(result);
}

/** Render an InvokeError through a `catches:` list. Falls back to a structured
 *  500 when no entry matches. Plain (non-InvokeError) throws never reach this
 *  function — the caller re-throws them to Fastify. */
export async function dispatchCatches(
  catches: CatchEntry[] | undefined,
  error: { code: string; message: string; data?: unknown },
  requestContext: Record<string, unknown>,
  moduleContext: ModuleLikeContext,
  validateSchema: ValidateSchema,
  reply: FastifyReply,
): Promise<void> {
  const celCtx = { error, ...requestContext };
  const entry = catches ? matchEntry(catches, celCtx, moduleContext) : undefined;

  if (!entry) {
    reply.code(500);
    reply.send({
      error: { code: error.code, message: error.message, data: error.data },
    });
    return;
  }

  reply.code(entry.status);

  if (entry.headers) {
    const mappedHeaders = moduleContext.expandWith(entry.headers, celCtx) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(mappedHeaders)) {
      reply.header(key, value as string);
    }
  }

  if (entry.body !== undefined) {
    const mappedBody = moduleContext.expandWith(entry.body, celCtx);
    if (entry.schema?.body) validateSchema(mappedBody, entry.schema.body);
    reply.send(mappedBody);
    return;
  }

  reply.send({ error: { code: error.code, message: error.message, data: error.data } });
}

export class HttpServerApi implements ResourceInstance {
  constructor(
    private readonly ctx: ResourceContext,
    readonly manifest: HttpApiManifest,
    private readonly handlerRefs: WeakMap<object, HandlerRef>,
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
    const handler = route.handler as unknown as ResourceInstance | undefined;
    const handlerRef = this.handlerRefs.get(route as unknown as object);
    const handlerKind = handlerRef?.kind ?? "";
    const handlerName = handlerRef?.name ?? "";
    const translatedPath = translateOpenApiPath(route.request.path);

    const schema: any = { response: {} };

    if (route.request.schema?.query) schema.querystring = route.request.schema.query;
    if (route.request.schema?.params) schema.params = route.request.schema.params;
    if (route.request.schema?.body) schema.body = route.request.schema.body;
    if (route.request.schema?.headers) schema.headers = route.request.schema.headers;

    for (const entry of route.returns) {
      if (entry.schema?.body) schema.response[entry.status] = entry.schema.body;
      else if (entry.schema) schema.response[entry.status] = {};
    }

    app.route({
      method: route.request.method as any,
      url: translatedPath,
      schema,
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
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
        const resolvedInputs: Record<string, any> = route.inputs
          ? ((this.ctx.moduleContext.expandWith(route.inputs, requestContext) as any) ?? {})
          : requestContext;
        const invokeInput: Record<string, any> = {
          ...resolvedInputs,
          inputs: resolvedInputs,
        };

        let result: unknown;
        try {
          result = handler
            ? await this.ctx.invokeResolved(handlerKind, handlerName, handler, invokeInput)
            : undefined;
        } catch (err) {
          if (!isInvokeError(err)) throw err;
          return dispatchCatches(
            route.catches,
            { code: err.code, message: err.message, data: err.data },
            requestContext,
            this.ctx.moduleContext,
            this.ctx.validateSchema.bind(this.ctx),
            reply,
          );
        }

        return dispatchReturns(
          route.returns,
          result,
          requestContext,
          this.ctx.moduleContext,
          this.ctx.validateSchema.bind(this.ctx),
          reply,
        );
      },
    });
  }
}

export async function create(resource: any, ctx: ResourceContext): Promise<HttpServerApi> {
  ctx.validateSchema(resource, HttpApiManifest);
  // Capture handler {kind, name} before Phase 5 injection overwrites the ref
  // with a live Invocable instance. invokeResolved() needs the kind/name to
  // emit properly-scoped Invoked / InvokeRejected events.
  const handlerRefs = new WeakMap<object, HandlerRef>();
  for (const route of resource.routes ?? []) {
    const h = route.handler;
    if (!h) continue;
    if (typeof h === "object") {
      handlerRefs.set(route, ctx.resolveChildren(h));
    } else if (typeof h === "string") {
      // String form (schema oneOf: string | object) — only the resource name
      // is given, not the kind. Phase 5 injects the live instance either way;
      // invoke events on this route just emit with an empty kind.
      handlerRefs.set(route, { kind: "", name: h });
    }
  }
  return new HttpServerApi(ctx, resource, handlerRefs);
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
