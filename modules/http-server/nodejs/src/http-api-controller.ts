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
  isInvokeError,
  KindRef,
  Ref,
  ResourceContext,
  ResourceInstance,
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
            body: request.body,
          },
        };
        const acceptHeader = (
          (request.headers as Record<string, string | string[] | undefined>)["accept"] as
            | string
            | undefined
        )?.toString();
        const resolvedInputs: Record<string, any> = route.inputs
          ? ((this.ctx.moduleContext.expandWith(route.inputs, requestContext) as any) ?? {})
          : requestContext;
        const invokeInput: Record<string, any> = {
          ...resolvedInputs,
          inputs: resolvedInputs,
        };

        const sink = fastifyReplySink(reply);

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
            acceptHeader,
            this.ctx.moduleContext,
            this.ctx.validateSchema.bind(this.ctx),
            sink,
          );
        }

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
