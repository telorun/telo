import { Static, Type } from "@sinclair/typebox";
import {
  CatchEntry,
  dispatchCatches,
  dispatchReturns,
  ReturnEntry,
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
import { LambdaApiV2Response, LambdaResponseSink } from "./common/lambda-response-sink.js";
import { matchHttpRoute } from "./common/match-http-route.js";

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
  handler: Type.Unsafe<KindRef<Invocable>>(Ref("telo#Invocable")),
  inputs: Type.Optional(Type.Record(Type.String(), Type.Any())),
  returns: Type.Array(ReturnEntry),
  catches: Type.Optional(Type.Array(CatchEntry)),
});
type HttpApiRouteManifest = Static<typeof HttpApiRouteManifest>;

const HttpApiCors = Type.Object({
  origin: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())]),
  ),
  methods: Type.Optional(Type.Array(Type.String())),
  allowedHeaders: Type.Optional(Type.Array(Type.String())),
  credentials: Type.Optional(Type.Boolean()),
  maxAge: Type.Optional(Type.Integer()),
});

const HttpApiManifest = Type.Object({
  cors: Type.Optional(HttpApiCors),
  routes: Type.Array(HttpApiRouteManifest),
});
type HttpApiManifest = Static<typeof HttpApiManifest>;

export async function register(_ctx: ControllerContext): Promise<void> {}

interface AwsHttpApiV2Event {
  version?: string;
  requestContext?: {
    http?: { method?: string; path?: string };
  };
  rawPath?: string;
  rawQueryString?: string;
  queryStringParameters?: Record<string, string>;
  pathParameters?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  isBase64Encoded?: boolean;
}

type HandlerRef = { kind: string; name: string };

/**
 * Lambda.HttpApi — API Gateway HTTP API v2 trigger. Dispatched by a
 * Lambda.Function when the incoming event's `requestContext.http` shape
 * matches the classifier entry.
 *
 * On invoke({event, context}): walk `routes[]`, match the first entry whose
 * `request.method` / `request.path` (OpenAPI-style placeholders) corresponds
 * to the event, expand `inputs:` CEL against the request context, invoke the
 * handler, render `returns:` / `catches:` through `@telorun/http-dispatch`'s
 * `dispatchReturns` / `dispatchCatches` via `LambdaResponseSink`. The sink's
 * accumulated state becomes the AWS HTTP API v2 response envelope returned
 * from `invoke()`.
 */
export class LambdaHttpApi implements ResourceInstance {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly manifest: HttpApiManifest,
    private readonly handlerRefs: WeakMap<object, HandlerRef>,
  ) {}

  async init(): Promise<void> {}

  async invoke(input: { event: AwsHttpApiV2Event; context: unknown }): Promise<LambdaApiV2Response> {
    const event = input.event ?? {};
    const method = event.requestContext?.http?.method?.toUpperCase() ?? "GET";
    const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";

    for (const route of this.manifest.routes ?? []) {
      if (route.request.method.toUpperCase() !== method) continue;

      const match = matchHttpRoute(route.request.path, path);
      if (!match) continue;
      // Prefer AWS-extracted path parameters when present (API Gateway populates
      // these for non-$default routes); fall back to the controller's local match.
      const params = event.pathParameters ?? match.params;
      return this.dispatch(route, event, params);
    }

    // No route matched. Mirrors http-server's default 404 — a minimal JSON body
    // so clients see something structured rather than AWS's raw "Missing
    // Authentication Token" default.
    return {
      statusCode: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: { code: "NOT_FOUND", message: `No route matched ${method} ${path}` },
      }),
    };
  }

  private async dispatch(
    route: HttpApiRouteManifest,
    event: AwsHttpApiV2Event,
    params: Record<string, string>,
  ): Promise<LambdaApiV2Response> {
    const requestContext = {
      request: {
        method: event.requestContext?.http?.method ?? "GET",
        path: event.rawPath ?? "/",
        params,
        query: event.queryStringParameters ?? {},
        headers: normaliseHeaders(event.headers ?? {}),
        body: decodeBody(event),
      },
    };
    const acceptHeader = pickHeader(event.headers, "accept");

    const resolvedInputs: Record<string, unknown> = route.inputs
      ? ((this.ctx.moduleContext.expandWith(route.inputs, requestContext) as Record<
          string,
          unknown
        >) ?? {})
      : (requestContext as unknown as Record<string, unknown>);
    const invokeInput: Record<string, unknown> = {
      ...resolvedInputs,
      inputs: resolvedInputs,
    };

    const handler = route.handler as unknown as ResourceInstance | undefined;
    const handlerRef = this.handlerRefs.get(route as unknown as object);
    const handlerKind = handlerRef?.kind ?? "";
    const handlerName = handlerRef?.name ?? "";

    const sink = new LambdaResponseSink();
    this.applyCorsHeaders(sink, event);

    try {
      const result = handler
        ? await this.ctx.invokeResolved(handlerKind, handlerName, handler, invokeInput)
        : undefined;
      await dispatchReturns(
        route.returns,
        result,
        requestContext,
        acceptHeader,
        this.ctx.moduleContext,
        this.ctx.validateSchema.bind(this.ctx),
        sink,
      );
    } catch (err) {
      if (!isInvokeError(err)) throw err;
      await dispatchCatches(
        route.catches,
        { code: err.code, message: err.message, data: err.data },
        requestContext,
        acceptHeader,
        this.ctx.moduleContext,
        this.ctx.validateSchema.bind(this.ctx),
        sink,
      );
    }
    return sink.getResponse();
  }

  private applyCorsHeaders(sink: LambdaResponseSink, event: AwsHttpApiV2Event): void {
    const cors = this.manifest.cors;
    if (!cors) return;
    const requestOrigin = pickHeader(event.headers, "origin");
    const allowed = pickCorsOrigin(cors.origin, requestOrigin);
    if (allowed !== undefined) sink.setHeader("access-control-allow-origin", allowed);
    if (cors.methods?.length) {
      sink.setHeader("access-control-allow-methods", cors.methods.join(","));
    }
    if (cors.allowedHeaders?.length) {
      sink.setHeader("access-control-allow-headers", cors.allowedHeaders.join(","));
    }
    if (cors.credentials) {
      sink.setHeader("access-control-allow-credentials", "true");
    }
    if (cors.maxAge !== undefined) {
      sink.setHeader("access-control-max-age", String(cors.maxAge));
    }
  }
}

function normaliseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = String(v);
  }
  return out;
}

function pickHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lc = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lc) return v;
  }
  return undefined;
}

function pickCorsOrigin(
  spec: string | string[] | undefined,
  requestOrigin: string | undefined,
): string | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec === "string") return spec;
  // Array: echo the request's Origin if it's in the allowlist; otherwise emit
  // nothing (browsers will block the response — closer to the spec than echoing
  // a non-matching wildcard).
  if (requestOrigin && spec.includes(requestOrigin)) return requestOrigin;
  return undefined;
}

function decodeBody(event: AwsHttpApiV2Event): unknown {
  if (event.body === undefined || event.body === null) return undefined;
  let raw: string;
  if (typeof event.body === "string") {
    raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
  } else {
    return event.body;
  }
  // Try JSON if the content type suggests it (or as a best-effort default).
  const contentType = pickHeader(event.headers, "content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export async function create(
  resource: any,
  ctx: ResourceContext,
): Promise<LambdaHttpApi> {
  ctx.validateSchema(resource, HttpApiManifest);
  const handlerRefs = new WeakMap<object, HandlerRef>();
  for (const route of (resource.routes ?? []) as Array<Record<string, unknown>>) {
    const h = route.handler;
    if (!h) continue;
    if (typeof h === "object") {
      handlerRefs.set(route, ctx.resolveChildren(h));
    } else if (typeof h === "string") {
      handlerRefs.set(route, { kind: "", name: h });
    }
  }
  return new LambdaHttpApi(ctx, resource as HttpApiManifest, handlerRefs);
}
