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
import type { OutgoingHttpHeaders } from "http";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

/** Per-MIME content-map entry. Buffer-mode responses use `body` (with optional
 *  `schema` for AJV validation); stream-mode responses use `encoder` (a ref to
 *  any `Codec.Encoder` implementation). The two are mutually exclusive per
 *  value — see dispatch logic. `headers` here merge over the entry-level
 *  `headers` (per-MIME wins on conflict). `Content-Type` is forbidden in
 *  headers — the map key IS the canonical Content-Type. */
const ContentEntry = Type.Object({
  body: Type.Optional(Type.Any()),
  schema: Type.Optional(Type.Any()),
  encoder: Type.Optional(Type.Unsafe<KindRef<Invocable>>(Ref("std/codec#Encoder"))),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});
type ContentEntry = Static<typeof ContentEntry>;

const ReturnEntry = Type.Object({
  status: Type.Integer({ minimum: 100, maximum: 599 }),
  when: Type.Optional(Type.String()),
  mode: Type.Optional(Type.Union([Type.Literal("buffer"), Type.Literal("stream")])),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  content: Type.Optional(Type.Record(Type.String(), ContentEntry)),
});
type ReturnEntry = Static<typeof ReturnEntry>;

const CatchEntry = Type.Object({
  status: Type.Integer({ minimum: 100, maximum: 599 }),
  when: Type.Optional(Type.String()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  // Catches are buffer-mode only — no `mode` or `encoder` fields. By the time
  // a catch fires, the response is committed pre-stream and there's no upstream
  // iterable to feed an encoder. content[mime] carries body/schema/headers only.
  content: Type.Optional(Type.Record(Type.String(), ContentEntry)),
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

export type { ReturnEntry, CatchEntry, ContentEntry };

type ModuleLikeContext = {
  expandWith: (v: unknown, ctx: Record<string, unknown>) => unknown;
};

type ValidateSchema = (value: unknown, schema: unknown) => void;

/** Hook invoked when `pipeline()` rejects after `reply.hijack()` — at that
 *  point headers are flushed, the response is committed, and `catches:`
 *  cannot fire. Surfacing the failure here lets operators observe mid-stream
 *  failures that are otherwise silent. */
type StreamErrorHook = (
  err: unknown,
  ctx: { status: number; mime: string },
) => Promise<void> | void;

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

/** Parse an `Accept` header into an array of `{type, q}` entries. Missing or
 *  empty headers default to `*\/*; q=1`. */
function parseAccept(header: string | undefined): Array<{ type: string; q: number }> {
  if (!header || !header.trim()) return [{ type: "*/*", q: 1 }];
  return header.split(",").map((part) => {
    const [mediaType, ...params] = part.trim().split(";").map((s) => s.trim());
    let q = 1;
    for (const p of params) {
      if (p.toLowerCase().startsWith("q=")) {
        const parsed = parseFloat(p.slice(2));
        if (!Number.isNaN(parsed)) q = parsed;
      }
    }
    return { type: (mediaType ?? "").toLowerCase(), q };
  });
}

/** Returns the highest q-value an `Accept` entry assigns to `mime`, or
 *  `undefined` if no Accept entry matches (or every match has q=0). Supports
 *  exact (`type/sub`), type-wildcard (`type/*`) and full-wildcard (`*\/*`). */
function matchAcceptForMime(
  mime: string,
  accepts: ReadonlyArray<{ type: string; q: number }>,
): number | undefined {
  const lc = mime.toLowerCase();
  const top = lc.split(";")[0]!;
  const slash = top.indexOf("/");
  const major = slash === -1 ? top : top.slice(0, slash);
  let best: number | undefined;
  for (const a of accepts) {
    if (a.q <= 0) continue;
    if (a.type === top || a.type === `${major}/*` || a.type === "*/*") {
      if (best === undefined || a.q > best) best = a.q;
    }
  }
  return best;
}

/** Pick the best content[mime] key per RFC 9110 §12.5.1 — highest q-value wins,
 *  declaration order breaks ties, q=0 excludes. Returns `undefined` when no
 *  available key matches the Accept header at any positive q-value. */
function negotiateContent(
  contentKeys: string[],
  acceptHeader: string | undefined,
): string | undefined {
  if (contentKeys.length === 0) return undefined;
  if (contentKeys.length === 1) {
    // Single-key map: skip negotiation entirely. The author has committed to
    // one Content-Type; either the client accepts it (any way) or 406 falls
    // out below.
    const accepts = parseAccept(acceptHeader);
    const q = matchAcceptForMime(contentKeys[0]!, accepts);
    return q === undefined ? undefined : contentKeys[0];
  }
  const accepts = parseAccept(acceptHeader);
  let best: { mime: string; q: number; index: number } | undefined;
  for (let i = 0; i < contentKeys.length; i++) {
    const mime = contentKeys[i]!;
    const q = matchAcceptForMime(mime, accepts);
    if (q === undefined) continue;
    if (!best || q > best.q || (q === best.q && i < best.index)) {
      best = { mime, q, index: i };
    }
  }
  return best?.mime;
}

/** Apply entry-level + per-MIME headers, with per-MIME winning on conflict.
 *  CEL templates in either map are expanded against `celCtx`. */
function applyHeaders(
  entryHeaders: Record<string, string> | undefined,
  contentHeaders: Record<string, string> | undefined,
  celCtx: Record<string, unknown>,
  moduleContext: ModuleLikeContext,
  reply: FastifyReply,
): void {
  for (const headers of [entryHeaders, contentHeaders]) {
    if (!headers) continue;
    const expanded = moduleContext.expandWith(headers, celCtx) as Record<string, unknown>;
    for (const [key, value] of Object.entries(expanded)) {
      reply.header(key, value as string);
    }
  }
}

export async function dispatchReturns(
  returns: ReturnEntry[],
  result: unknown,
  requestContext: Record<string, unknown>,
  acceptHeader: string | undefined,
  moduleContext: ModuleLikeContext,
  validateSchema: ValidateSchema,
  reply: FastifyReply,
  streamError?: StreamErrorHook,
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

  // Status codes with no body (204, 304, etc.) — entry has no `content:` map.
  if (!entry.content || Object.keys(entry.content).length === 0) {
    reply.code(entry.status);
    applyHeaders(entry.headers, undefined, celCtx, moduleContext, reply);
    reply.send();
    return;
  }

  const contentKeys = Object.keys(entry.content);
  const matchedMime = negotiateContent(contentKeys, acceptHeader);

  if (!matchedMime) {
    // No Accept-header match at any positive q-value — RFC 9110 §15.5.7.
    reply.code(406);
    reply.header("Content-Type", "application/json");
    reply.send({
      error: {
        code: "NOT_ACCEPTABLE",
        message: "No representation matched the Accept header.",
        available: contentKeys,
      },
    });
    return;
  }

  const contentEntry = entry.content[matchedMime]!;

  reply.code(entry.status);
  reply.header("Content-Type", matchedMime);
  applyHeaders(entry.headers, contentEntry.headers, celCtx, moduleContext, reply);

  if (entry.mode === "stream") {
    if (!contentEntry.encoder) {
      throw new Error(
        `Stream-mode return for status ${entry.status} content[${matchedMime}] is missing an encoder.`,
      );
    }
    const encoderInstance = contentEntry.encoder as unknown as ResourceInstance;
    if (typeof (encoderInstance as { invoke?: unknown }).invoke !== "function") {
      throw new Error(
        `Encoder ref for status ${entry.status} content[${matchedMime}] is not a live Invocable — Phase 5 injection may have failed.`,
      );
    }
    const handlerOutput = (result as { output?: AsyncIterable<unknown> } | null | undefined)
      ?.output;
    if (!handlerOutput || typeof (handlerOutput as any)[Symbol.asyncIterator] !== "function") {
      throw new Error(
        `Stream-mode handler did not return { output: AsyncIterable<...> } for status ${entry.status} content[${matchedMime}]; got ${typeof handlerOutput}.`,
      );
    }
    const encoded = (await (encoderInstance as unknown as {
      invoke: (i: { input: AsyncIterable<unknown> }) => Promise<{ output: AsyncIterable<Uint8Array> }>;
    }).invoke({ input: handlerOutput }));
    if (!encoded || typeof (encoded.output as any)?.[Symbol.asyncIterator] !== "function") {
      throw new Error(
        `Encoder for status ${entry.status} content[${matchedMime}] did not return { output: AsyncIterable<Uint8Array> }.`,
      );
    }
    reply.hijack();
    reply.raw.writeHead(entry.status, reply.getHeaders() as OutgoingHttpHeaders);
    // Readable.from wraps the AsyncIterable; pipeline() handles backpressure
    // and propagates client disconnect back through the iterator chain via
    // .return(), which unwinds the encoder's `for await` and reaches the
    // source's `.return()` (e.g. cancelling a provider's streamText call).
    //
    // Once headers are flushed, mid-stream failures (encoder throw, broken
    // pipe, etc.) cannot trigger `catches:` — the response is committed.
    // Surface them via `streamError` so operators can see what's bypassing
    // the catch chain by design. The socket will close; we don't rethrow
    // because Fastify can't render anything useful past hijack().
    try {
      await pipeline(Readable.from(encoded.output), reply.raw);
    } catch (err) {
      if (streamError) {
        try {
          await streamError(err, { status: entry.status, mime: matchedMime });
        } catch {
          /* operator hook should never fail the response — swallow */
        }
      }
    }
    return;
  }

  // Buffer mode (default).
  if (contentEntry.body !== undefined) {
    const mappedBody = moduleContext.expandWith(contentEntry.body, celCtx);
    if (contentEntry.schema) validateSchema(mappedBody, contentEntry.schema);
    reply.send(mappedBody);
    return;
  }

  // No explicit body — fall through to sending the handler's result as-is.
  // Preserves the legacy "reply.send(result)" shorthand for routes whose
  // handler already returns the right shape.
  if (contentEntry.schema) validateSchema(result, contentEntry.schema);
  reply.send(result);
}

/** Render an InvokeError through a `catches:` list. Falls back to a structured
 *  500 when no entry matches. Plain (non-InvokeError) throws never reach this
 *  function — the caller re-throws them to Fastify.
 *
 *  Catches are buffer-mode only by design: by the time a catch fires the
 *  response is committed pre-stream and there's no upstream iterable to feed
 *  an encoder. content[mime] entries carry body/schema/headers; encoder/mode
 *  fields are not part of the catch schema. */
export async function dispatchCatches(
  catches: CatchEntry[] | undefined,
  error: { code: string; message: string; data?: unknown },
  requestContext: Record<string, unknown>,
  acceptHeader: string | undefined,
  moduleContext: ModuleLikeContext,
  validateSchema: ValidateSchema,
  reply: FastifyReply,
): Promise<void> {
  const celCtx = { error, ...requestContext };
  const entry = catches ? matchEntry(catches, celCtx, moduleContext) : undefined;

  if (!entry) {
    reply.code(500);
    reply.header("Content-Type", "application/json");
    reply.send({
      error: { code: error.code, message: error.message, data: error.data },
    });
    return;
  }

  if (!entry.content || Object.keys(entry.content).length === 0) {
    reply.code(entry.status);
    applyHeaders(entry.headers, undefined, celCtx, moduleContext, reply);
    reply.send();
    return;
  }

  const contentKeys = Object.keys(entry.content);
  const matchedMime = negotiateContent(contentKeys, acceptHeader);

  if (!matchedMime) {
    reply.code(406);
    reply.header("Content-Type", "application/json");
    reply.send({
      error: {
        code: "NOT_ACCEPTABLE",
        message: "No catch representation matched the Accept header.",
        available: contentKeys,
      },
    });
    return;
  }

  const contentEntry = entry.content[matchedMime]!;
  reply.code(entry.status);
  reply.header("Content-Type", matchedMime);
  applyHeaders(entry.headers, contentEntry.headers, celCtx, moduleContext, reply);

  if (contentEntry.body !== undefined) {
    const mappedBody = moduleContext.expandWith(contentEntry.body, celCtx);
    if (contentEntry.schema) validateSchema(mappedBody, contentEntry.schema);
    reply.send(mappedBody);
    return;
  }

  // Default error envelope when no body is given. The matched MIME may be
  // text/plain (or any non-JSON shape) — the negotiated Content-Type would
  // lie about a JSON payload. Override to application/json to keep the
  // envelope honest. Authors who want the matched MIME on the wire must
  // provide an explicit `body:` for that content[mime] entry.
  reply.header("Content-Type", "application/json");
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
            reply,
          );
        }

        return dispatchReturns(
          route.returns,
          result,
          requestContext,
          acceptHeader,
          this.ctx.moduleContext,
          this.ctx.validateSchema.bind(this.ctx),
          reply,
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
  validateContentEntryShape(resource);
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

/** Rejects `Content-Type` (case-insensitive) anywhere in entry-level or
 *  per-MIME `headers:` blocks. The matched `content[mime]` map key IS the
 *  canonical Content-Type — declaring it again in `headers:` would either be
 *  redundant or contradictory. */
export function validateNoContentTypeHeader(resource: {
  routes?: Array<{
    request?: { path?: string };
    returns?: ReturnEntry[];
    catches?: CatchEntry[];
  }>;
}): void {
  for (const route of resource.routes ?? []) {
    const path = route.request?.path ?? "<unknown>";
    for (const list of [route.returns, route.catches] as Array<
      ReturnEntry[] | CatchEntry[] | undefined
    >) {
      if (!list) continue;
      for (const entry of list) {
        rejectContentTypeIn(entry.headers, `${path} entry-level headers`);
        if (!entry.content) continue;
        for (const [mime, c] of Object.entries(entry.content)) {
          rejectContentTypeIn((c as ContentEntry).headers, `${path} content[${mime}].headers`);
        }
      }
    }
  }
}

function rejectContentTypeIn(
  headers: Record<string, string> | undefined,
  where: string,
): void {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "content-type") {
      throw new Error(
        `Http.Api: '${where}' declares 'Content-Type' — forbidden. The matched content[mime] map key is the only Content-Type source.`,
      );
    }
  }
}

/** Enforces per-mode shape rules on every `content[mime]` value:
 *   - `body` and `encoder` are mutually exclusive. Declaring both is rejected
 *     because dispatch would silently pick one based on entry `mode:` and the
 *     other becomes a no-op — a correctness footgun.
 *   - `mode: stream` requires every content[mime] to declare `encoder` (and
 *     forbids `body`). Without this check, an entry with one encoder-bearing
 *     key plus a body-only key would pass at load and only fail at runtime
 *     when the body-only key won negotiation — leaving a half-broken route.
 *   - `mode: buffer` (the default) forbids `encoder` (which would never run). */
export function validateContentEntryShape(resource: {
  routes?: Array<{
    request?: { path?: string };
    returns?: ReturnEntry[];
  }>;
}): void {
  for (const route of resource.routes ?? []) {
    const path = route.request?.path ?? "<unknown>";
    for (const entry of route.returns ?? []) {
      const isStream = entry.mode === "stream";
      // Stream mode requires a non-empty content map — without one the
      // dispatcher would silently send an empty 200, masking the misconfig.
      // Buffer mode (default) tolerates missing content (e.g. 204/304-style
      // empty responses); the dispatcher renders status-only in that case.
      if (isStream && (!entry.content || Object.keys(entry.content).length === 0)) {
        throw new Error(
          `Http.Api: '${path}' status ${entry.status} mode: stream is missing 'content:'. ` +
            `Stream-mode entries must declare at least one content[mime] with an encoder.`,
        );
      }
      if (!entry.content) continue;
      for (const [mime, c] of Object.entries(entry.content)) {
        const value = c as ContentEntry;
        const hasBody = value.body !== undefined;
        const hasEncoder = value.encoder !== undefined;
        if (hasBody && hasEncoder) {
          throw new Error(
            `Http.Api: '${path}' content[${mime}] declares both 'body' and 'encoder' — forbidden. ` +
              `Buffer-mode entries use 'body'; stream-mode entries use 'encoder'.`,
          );
        }
        if (isStream && !hasEncoder) {
          throw new Error(
            `Http.Api: '${path}' status ${entry.status} mode: stream content[${mime}] is missing 'encoder'. ` +
              `Every content[mime] under a stream-mode return must declare an encoder.`,
          );
        }
        if (isStream && hasBody) {
          throw new Error(
            `Http.Api: '${path}' status ${entry.status} mode: stream content[${mime}] declares 'body' — forbidden. ` +
              `Stream-mode entries use 'encoder', not 'body'.`,
          );
        }
        if (!isStream && hasEncoder) {
          throw new Error(
            `Http.Api: '${path}' status ${entry.status} content[${mime}] declares 'encoder' but mode is 'buffer' (default) — ` +
              `the encoder would never run. Set mode: stream, or use 'body' for buffer-mode responses.`,
          );
        }
      }
    }
  }
}

/** Rejects `when:` CEL expressions on stream-mode `returns:` entries that
 *  reference the root `result` identifier. The handler result in stream mode
 *  is an unconsumed `Stream<...>`; iterating it to evaluate the predicate
 *  would either fail or consume the stream before bytes flow to the response.
 *  References to `request.*` are fine — they don't touch the stream.
 *
 *  This is a runtime safety net; the analyzer's static chain validator is
 *  authoritative. The check here is intentionally token-aware (skips string
 *  literals and `.result` member access) so it doesn't false-positive on
 *  benign expressions like `request.headers["x-result"]`. */
export function validateStreamWhenDoesNotReferenceResult(resource: {
  routes?: Array<{
    request?: { path?: string };
    returns?: ReturnEntry[];
  }>;
}): void {
  for (const route of resource.routes ?? []) {
    const path = route.request?.path ?? "<unknown>";
    for (const entry of route.returns ?? []) {
      if (entry.mode !== "stream" || !entry.when) continue;
      // `when:` survived precompilation as a CompiledValue (or a raw string
      // when no template was applied). Inspect the source text via a token
      // walker — naive `\bresult\b` would false-positive inside string
      // literals and on `.result` property paths.
      const source =
        typeof entry.when === "string"
          ? entry.when
          : (entry.when as { source?: string })?.source ?? "";
      if (referencesRootIdentifier(source, "result")) {
        throw new Error(
          `Http.Api: '${path}' returns entry with mode: stream — 'when:' references the root 'result' identifier. ` +
            `The handler result is an unconsumed Stream and cannot be inspected from CEL. ` +
            `Reference only request.* in stream-mode 'when:' predicates.`,
        );
      }
    }
  }
}

/** True if `source` contains a free-standing CEL identifier `target` —
 *  i.e. it appears as a root identifier (not preceded by `.`, not part of
 *  another word) and not inside a single- or double-quoted string literal.
 *  Token-aware so members like `request.result_count` and string literals
 *  like `'my result'` don't trigger a match. */
function referencesRootIdentifier(source: string, target: string): boolean {
  let i = 0;
  let inString: '"' | "'" | null = null;
  while (i < source.length) {
    const ch = source[i]!;
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j++;
      const word = source.slice(i, j);
      // Walk back over whitespace; if the previous non-whitespace char is `.`,
      // this identifier is a member access, not a root identifier.
      let k = i - 1;
      while (k >= 0 && /\s/.test(source[k]!)) k--;
      const isMember = k >= 0 && source[k] === ".";
      if (word === target && !isMember) return true;
      i = j;
      continue;
    }
    i++;
  }
  return false;
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
