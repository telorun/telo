import type { ResourceInstance } from "@telorun/sdk";
import type { CatchEntry, ContentEntry, ReturnEntry } from "./schema.js";
import type { ResponseSink, StreamErrorHook } from "./sink.js";

/** Subset of `ModuleContext` the dispatcher uses — kept narrow so the
 *  dispatcher does not pull the kernel/SDK module-context type, and to keep
 *  the package's surface easy to mock in tests. */
export type ModuleLikeContext = {
  expandWith: (v: unknown, ctx: Record<string, unknown>) => unknown;
};

export type ValidateSchema = (value: unknown, schema: unknown) => void;

/** Pick the first entry whose `when:` evaluates strictly to `true`, falling
 *  back to the first entry whose `when:` is omitted (the list's catch-all).
 *
 *  Absence is checked with `=== undefined`, not truthiness: the manifest
 *  schema declares `when` as a boolean, so after CEL compilation the value is
 *  either a CompiledValue (for `${{ ... }}`) or a literal boolean (for
 *  `when: true` / `when: false`). A truthiness check would mis-classify the
 *  literal `false` case as "no when field" and let it become the fallback —
 *  see modules/mcp-server/nodejs/src/outcome.ts for the same precaution. */
function matchEntry<T extends { when?: unknown }>(
  entries: T[],
  celCtx: Record<string, unknown>,
  moduleContext: ModuleLikeContext,
): T | undefined {
  let fallback: T | undefined;
  for (const entry of entries) {
    if (entry.when === undefined) {
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

/** Returns the q-value an `Accept` header assigns to `mime` per RFC 9110
 *  §12.5.1 — most specific media range wins, ties on specificity broken by
 *  highest q. Returns `undefined` when no range matches at all OR when the
 *  most specific match has q=0 (explicit exclusion).
 *
 *  Specificity ranks: 2 = exact `type/subtype`, 1 = type-wildcard `type/*`,
 *  0 = full wildcard `*\/*`. This keeps `Accept: application/json;q=0, *\/*;q=1`
 *  from accidentally matching `application/json` via the wildcard — the
 *  client's exact-match exclusion is honored over the catch-all. */
function matchAcceptForMime(
  mime: string,
  accepts: ReadonlyArray<{ type: string; q: number }>,
): number | undefined {
  const lc = mime.toLowerCase();
  const top = lc.split(";")[0]!;
  const slash = top.indexOf("/");
  const major = slash === -1 ? top : top.slice(0, slash);
  let bestSpecificity = -1;
  let bestQ = -1;
  for (const a of accepts) {
    let specificity: number;
    if (a.type === top) specificity = 2;
    else if (a.type === `${major}/*`) specificity = 1;
    else if (a.type === "*/*") specificity = 0;
    else continue;
    if (specificity > bestSpecificity || (specificity === bestSpecificity && a.q > bestQ)) {
      bestSpecificity = specificity;
      bestQ = a.q;
    }
  }
  if (bestSpecificity === -1 || bestQ <= 0) return undefined;
  return bestQ;
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
  sink: ResponseSink,
): void {
  for (const headers of [entryHeaders, contentHeaders]) {
    if (!headers) continue;
    const expanded = moduleContext.expandWith(headers, celCtx) as Record<string, unknown>;
    for (const [key, value] of Object.entries(expanded)) {
      sink.setHeader(key, value as string);
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
  sink: ResponseSink,
  streamError?: StreamErrorHook,
): Promise<void> {
  const celCtx = { result, ...requestContext };
  const entry = matchEntry(returns, celCtx, moduleContext);

  if (!entry) {
    // Unreachable when the analyzer has run — every route's returns: list must
    // cover its handler's return values (explicit when: or catch-all). Hitting
    // this at runtime means something bypassed analysis; surface it loudly
    // rather than quietly render a 500.
    throw new Error(
      "No matching returns entry for handler result — the route's returns: list must cover every return value (add a catch-all entry or widen a when: clause)",
    );
  }

  // Status codes with no body (204, 304, etc.) — entry has no `content:` map.
  if (!entry.content || Object.keys(entry.content).length === 0) {
    sink.setStatus(entry.status);
    applyHeaders(entry.headers, undefined, celCtx, moduleContext, sink);
    await sink.send();
    return;
  }

  const contentKeys = Object.keys(entry.content);
  const matchedMime = negotiateContent(contentKeys, acceptHeader);

  if (!matchedMime) {
    // No Accept-header match at any positive q-value — RFC 9110 §15.5.7.
    sink.setStatus(406);
    sink.setHeader("Content-Type", "application/json");
    await sink.send({
      error: {
        code: "NOT_ACCEPTABLE",
        message: "No representation matched the Accept header.",
        available: contentKeys,
      },
    });
    return;
  }

  const contentEntry = entry.content[matchedMime]!;

  sink.setStatus(entry.status);
  sink.setHeader("Content-Type", matchedMime);
  applyHeaders(entry.headers, contentEntry.headers, celCtx, moduleContext, sink);

  if (entry.mode === "stream") {
    await dispatchStream(entry.status, matchedMime, contentEntry, result, sink, streamError);
    return;
  }

  // Buffer mode (default).
  if (contentEntry.body !== undefined) {
    const mappedBody = moduleContext.expandWith(contentEntry.body, celCtx);
    if (contentEntry.schema) validateSchema(mappedBody, contentEntry.schema);
    await sink.send(mappedBody);
    return;
  }

  // No explicit body — fall through to sending the handler's result as-is.
  // Preserves the legacy "send(result)" shorthand for routes whose handler
  // already returns the right shape.
  if (contentEntry.schema) validateSchema(result, contentEntry.schema);
  await sink.send(result);
}

async function dispatchStream(
  status: number,
  matchedMime: string,
  contentEntry: ContentEntry,
  result: unknown,
  sink: ResponseSink,
  streamError: StreamErrorHook | undefined,
): Promise<void> {
  if (!contentEntry.encoder) {
    throw new Error(
      `Stream-mode return for status ${status} content[${matchedMime}] is missing an encoder.`,
    );
  }
  const encoderInstance = contentEntry.encoder as unknown as ResourceInstance;
  if (typeof (encoderInstance as { invoke?: unknown }).invoke !== "function") {
    throw new Error(
      `Encoder ref for status ${status} content[${matchedMime}] is not a live Invocable — Phase 5 injection may have failed.`,
    );
  }
  const handlerOutput = (result as { output?: AsyncIterable<unknown> } | null | undefined)?.output;
  if (!handlerOutput || typeof (handlerOutput as any)[Symbol.asyncIterator] !== "function") {
    throw new Error(
      `Stream-mode handler did not return { output: AsyncIterable<...> } for status ${status} content[${matchedMime}]; got ${typeof handlerOutput}.`,
    );
  }
  const encoded = await (encoderInstance as unknown as {
    invoke: (i: { input: AsyncIterable<unknown> }) => Promise<{ output: AsyncIterable<Uint8Array> }>;
  }).invoke({ input: handlerOutput });
  if (!encoded || typeof (encoded.output as any)?.[Symbol.asyncIterator] !== "function") {
    throw new Error(
      `Encoder for status ${status} content[${matchedMime}] did not return { output: AsyncIterable<Uint8Array> }.`,
    );
  }

  // Close over status + mime here so the per-event callback the sink receives
  // doesn't need the sink interface to carry {status, mime} parameters it
  // would otherwise never use.
  const onError = streamError
    ? async (err: unknown) => {
        try {
          await streamError(err, { status, mime: matchedMime });
        } catch {
          /* operator hook should never fail the response — swallow */
        }
      }
    : undefined;

  await sink.stream(encoded.output, onError);
}

/** Render an InvokeError through a `catches:` list. Falls back to a structured
 *  500 when no entry matches. Plain (non-InvokeError) throws never reach this
 *  function — the caller re-throws them to its transport.
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
  sink: ResponseSink,
): Promise<void> {
  const celCtx = { error, ...requestContext };
  const entry = catches ? matchEntry(catches, celCtx, moduleContext) : undefined;

  if (!entry) {
    sink.setStatus(500);
    sink.setHeader("Content-Type", "application/json");
    await sink.send({
      error: { code: error.code, message: error.message, data: error.data },
    });
    return;
  }

  if (!entry.content || Object.keys(entry.content).length === 0) {
    sink.setStatus(entry.status);
    applyHeaders(entry.headers, undefined, celCtx, moduleContext, sink);
    await sink.send();
    return;
  }

  const contentKeys = Object.keys(entry.content);
  const matchedMime = negotiateContent(contentKeys, acceptHeader);

  if (!matchedMime) {
    sink.setStatus(406);
    sink.setHeader("Content-Type", "application/json");
    await sink.send({
      error: {
        code: "NOT_ACCEPTABLE",
        message: "No catch representation matched the Accept header.",
        available: contentKeys,
      },
    });
    return;
  }

  const contentEntry = entry.content[matchedMime]!;
  sink.setStatus(entry.status);
  sink.setHeader("Content-Type", matchedMime);
  applyHeaders(entry.headers, contentEntry.headers, celCtx, moduleContext, sink);

  if (contentEntry.body !== undefined) {
    const mappedBody = moduleContext.expandWith(contentEntry.body, celCtx);
    if (contentEntry.schema) validateSchema(mappedBody, contentEntry.schema);
    await sink.send(mappedBody);
    return;
  }

  // Default error envelope when no body is given. The matched MIME may be
  // text/plain (or any non-JSON shape) — the negotiated Content-Type would
  // lie about a JSON payload. Override to application/json to keep the
  // envelope honest. Authors who want the matched MIME on the wire must
  // provide an explicit `body:` for that content[mime] entry.
  sink.setHeader("Content-Type", "application/json");
  await sink.send({ error: { code: error.code, message: error.message, data: error.data } });
}
