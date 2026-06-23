import { Static, Type } from "@sinclair/typebox";
import {
  CatchEntry,
  ContentEntry,
  dispatchCatches,
  dispatchReturns,
  ReturnEntry,
  validateNoContentTypeHeader,
  validateStreamWhenDoesNotReferenceResult,
} from "@telorun/http-dispatch";
import {
  ControllerContext,
  Invocable,
  InvokeError,
  isCancellationError,
  isInvokeError,
  KindRef,
  Ref,
  ResourceContext,
  ResourceInstance,
  Stream,
} from "@telorun/sdk";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fastifyReplySink } from "./fastify-reply-sink.js";

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
  operationId: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
});
type HttpApiRouteManifest = Static<typeof HttpApiRouteManifest>;

const HttpApiManifest = Type.Object({
  routes: Type.Array(HttpApiRouteManifest),
});
type HttpApiManifest = Static<typeof HttpApiManifest>;

export async function register(_ctx: ControllerContext): Promise<void> {}

export type { CatchEntry, ContentEntry, ReturnEntry };

type HandlerRef = { kind: string; name: string };

export class HttpServerApi implements ResourceInstance {
  constructor(
    private readonly ctx: ResourceContext,
    readonly manifest: HttpApiManifest,
    private readonly handlerRefs: WeakMap<object, HandlerRef>,
    private readonly apiName: string,
  ) {}

  async init() {}

  register(app: FastifyInstance, prefix = "") {
    // Register each route at its full `prefix + path` on the root app rather than
    // inside a `{ prefix }`-encapsulated context. Fastify encapsulation makes
    // @fastify/swagger strip the prefix from the documented path, which conflates
    // routes from different mounts (e.g. an Api at `/admin` documented as `/links`).
    // Carrying the prefix on the path keeps the OpenAPI doc unambiguous for any mix
    // of mounts; a single `servers` origin is set by the server controller.
    this.registerRoutes(app, normalizeMountPrefix(prefix));
  }

  private registerRoutes(app: FastifyInstance, prefix: string) {
    const routes = this.manifest.routes || [];
    for (const route of routes) {
      this.registerRoute(app, route, prefix);
    }
  }

  private registerRoute(app: FastifyInstance, route: HttpApiRouteManifest, prefix: string) {
    // After Phase 5 injection, KindRef<Invocable> is replaced with the live Invocable instance.
    const handler = route.handler as unknown as ResourceInstance | undefined;
    const handlerRef = this.handlerRefs.get(route as unknown as object);
    const handlerKind = handlerRef?.kind ?? "";
    const handlerName = handlerRef?.name ?? "";
    const translatedPath = joinMountPath(prefix, translateOpenApiPath(route.request.path));

    const schema: any = { response: {} };

    // A stream-marked body is delivered as a raw `Stream<Uint8Array>` (see the
    // server's `contentTypeParsers[].stream`); it is opaque to AJV, so skip
    // body-schema registration and wrap the raw request stream in the handler.
    const streamBody = route.request.schema?.body?.["x-telo-stream"] === true;

    if (route.request.schema?.query) schema.querystring = route.request.schema.query;
    if (route.request.schema?.params) schema.params = route.request.schema.params;
    if (route.request.schema?.body && !streamBody) schema.body = route.request.schema.body;
    if (route.request.schema?.headers) schema.headers = route.request.schema.headers;

    // OpenAPI operation metadata — @fastify/swagger reads these off the route
    // schema and renders them into the generated document.
    if (route.operationId) schema.operationId = route.operationId;
    if (route.summary) schema.summary = route.summary;
    if (route.description) schema.description = route.description;
    if (route.tags) schema.tags = route.tags;

    // Response schemas: register the FIRST content[mime].schema we find for
    // each status. Multiple MIMEs per status all get the same response shape
    // (Fastify's response schema is per-status, not per-MIME); the per-MIME
    // schema field is for AJV validation in dispatchReturns, separate from
    // Fastify's per-status response schema registration.
    for (const entry of route.returns) {
      if (!entry.content) continue;
      for (const [, c] of Object.entries(entry.content)) {
        if (c.schema && schema.response[entry.status] === undefined) {
          schema.response[entry.status] = c.schema;
        }
      }
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
            body: streamBody ? toByteStream(request) : request.body,
            // Canonical client address — honours X-Forwarded-For per the
            // server's `trustProxy` setting (Fastify resolves it).
            ip: request.ip,
          },
        };
        const acceptHeader = (
          (request.headers as Record<string, string | string[] | undefined>)["accept"] as
            | string
            | undefined
        )?.toString();
        // The handler receives the resolved inputs directly: a templated handler's
        // `${{ inputs.X }}` reads these as its `inputs` bag, and a plain invocable
        // reads the fields off its argument. (This previously also nested a second
        // `inputs: resolvedInputs` copy — which nothing read, and which surfaced as
        // duplicated data in the debug trace.)
        const invokeInput: Record<string, any> = route.inputs
          ? ((this.ctx.moduleContext.expandWith(route.inputs, requestContext) as any) ?? {})
          : requestContext;

        const sink = fastifyReplySink(reply);

        // Per-request cancellation: abandon downstream work when the client
        // disconnects before the response is sent. Listen on the response
        // socket, not the request stream — the latter's `close` fires as normal
        // cleanup once a request body has been fully received, which would
        // cancel any body-bearing request that awaits (e.g. a DB call) before
        // replying. The response socket only closes early on a real disconnect.
        const cancellation = this.ctx.createCancellationSource();
        reply.raw.on("close", () => {
          if (!reply.sent) cancellation.cancel("client-disconnect");
        });

        // Open a request span rooting this request's own trace: the handler (and
        // its nested invokes) nest under it, and it's labelled with the route so
        // the trace shows the actual method+path, attributed to this Http.Api.
        const span = await this.ctx.openSpan(cancellation.context, {
          ref: { kind: "Http.Api", name: this.apiName },
          label: `${route.request.method} ${route.request.path}`,
          attributes: { method: route.request.method, path: route.request.path },
        });

        let result: unknown;
        try {
          result = handler
            ? await this.ctx.invokeResolved(
                handlerKind,
                handlerName,
                handler,
                invokeInput,
                span.context,
              )
            : undefined;
        } catch (err) {
          if (isCancellationError(err)) {
            await span.settle("cancelled");
            if (!reply.sent) reply.code(499).send();
            return;
          }
          if (!isInvokeError(err)) {
            await span.settle("failed");
            throw err;
          }
          await span.settle("rejected");
          return dispatchCatches(
            route.catches,
            { code: err.code, message: err.message, data: err.data },
            requestContext,
            acceptHeader,
            this.ctx.moduleContext,
            this.ctx.validateSchema.bind(this.ctx),
            sink,
          );
        }

        await span.settle("ok");
        return dispatchReturns(
          route.returns,
          result,
          requestContext,
          acceptHeader,
          this.ctx.moduleContext,
          this.ctx.validateSchema.bind(this.ctx),
          sink,
          (err, errCtx) =>
            this.ctx.emitEvent("Http.Api.streamFailed", {
              path: route.request.path,
              method: route.request.method,
              status: errCtx.status,
              mime: errCtx.mime,
              error:
                err instanceof Error
                  ? { message: err.message, stack: err.stack, code: (err as { code?: string }).code }
                  : { message: String(err) },
            }),
        );
      },
    });
  }
}

export async function create(resource: any, ctx: ResourceContext): Promise<HttpServerApi> {
  ctx.validateSchema(resource, HttpApiManifest);
  validateNoContentTypeHeader(resource);
  validateStreamWhenDoesNotReferenceResult(resource);
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
  return new HttpServerApi(ctx, resource, handlerRefs, resource?.metadata?.name ?? "");
}

/**
 * Translates OpenAPI path format {paramName} to Fastify format :paramName
 * Example: /api/v1/users/{userId} -> /api/v1/users/:userId
 */
function translateOpenApiPath(openApiPath: string): string {
  return openApiPath.replace(/{([a-zA-Z_][a-zA-Z0-9_]*)}/g, ":$1");
}

/**
 * Normalizes a mount prefix into a path segment that prepends cleanly to a route
 * path: the root mount (`""` / `"/"`) contributes nothing, and a trailing slash
 * is dropped so `"/admin" + "/links"` is `/admin/links`, never `/admin//links`.
 */
function normalizeMountPrefix(prefix: string): string {
  if (!prefix || prefix === "/") return "";
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

/** Join a normalized mount prefix with a translated route path. A collection
 *  route declared at `/` sits at the mount root itself (`/todos` + `/` → `/todos`),
 *  not a trailing-slash variant Fastify would treat as a distinct, unmatched URL.
 *  An empty prefix (root mount) keeps `/`. */
function joinMountPath(prefix: string, path: string): string {
  if (path === "/") return prefix || "/";
  return prefix + path;
}

/**
 * Wraps an incoming request's raw body as a `Stream<Uint8Array>`. Requires a
 * stream content-type parser (`contentTypeParsers[].stream`) for the request's
 * Content-Type — only then is `request.body` the undrained payload stream.
 * Without one, Fastify has already consumed the socket to build a string/object
 * body, so `request.raw` is drained; fail fast with an actionable error rather
 * than yield an empty stream or hang.
 */
function toByteStream(request: FastifyRequest): Stream<Uint8Array> {
  const body = request.body as unknown;
  if (!body || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
    const contentType = (request.headers["content-type"] as string | undefined) ?? "(none)";
    throw new InvokeError(
      "ERR_REQUEST_BODY_NOT_STREAMED",
      `Route declares an x-telo-stream request body, but the body for content-type ` +
        `"${contentType}" arrived parsed, not streamed. Register a raw stream parser on ` +
        `the Http.Server: contentTypeParsers: [{ contentType: "${contentType}", stream: true }].`,
    );
  }
  return new Stream(toUint8Chunks(body as AsyncIterable<Uint8Array | Buffer>));
}

async function* toUint8Chunks(
  source: AsyncIterable<Uint8Array | Buffer>,
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  }
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
