import {
  ERR_INVOKE_CANCELLED,
  InvokeError,
  Stream,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { PassThrough, Readable } from "stream";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT = 10000;

interface TeloResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

interface NetworkErrorPayload {
  error: "NetworkError";
  code: "TIMEOUT" | "CONNECTION_REFUSED" | "DNS_RESOLUTION_FAILED" | "SSL_ERROR";
  message: string;
  details: { url: string };
}

function createNetworkError(
  code: NetworkErrorPayload["code"],
  message: string,
  url: string,
): Error {
  const payload: NetworkErrorPayload = {
    error: "NetworkError",
    code,
    message,
    details: { url },
  };
  const err = new Error(message);
  (err as any).networkError = payload;
  (err as any).code = code;
  Object.assign(err, payload);
  return err;
}

function mapNetworkError(err: unknown, url: string): never {
  const e = err as Error;
  if (e.name === "AbortError") {
    throw createNetworkError("TIMEOUT", `Request timed out`, url);
  }
  const msg = e.message?.toLowerCase() ?? "";
  if (msg.includes("econnrefused") || msg.includes("connection refused")) {
    throw createNetworkError("CONNECTION_REFUSED", e.message, url);
  }
  if (msg.includes("enotfound") || msg.includes("getaddrinfo") || msg.includes("dns")) {
    throw createNetworkError("DNS_RESOLUTION_FAILED", e.message, url);
  }
  if (msg.includes("ssl") || msg.includes("cert") || msg.includes("tls")) {
    throw createNetworkError("SSL_ERROR", e.message, url);
  }
  throw createNetworkError("CONNECTION_REFUSED", e.message, url);
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

async function executeRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeout: number,
  stream = false,
  callerSignal?: AbortSignal,
): Promise<TeloResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  // Caller cancellation and the request timeout both abort the fetch.
  const signal = callerSignal
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal;

  let currentUrl = url;
  let redirectsLeft = MAX_REDIRECTS;

  try {
    while (true) {
      const response = await fetch(currentUrl, {
        method,
        headers,
        body,
        redirect: "manual",
        signal,
      });

      // Handle redirects manually (limit to MAX_REDIRECTS)
      if ((response.status === 301 || response.status === 302) && redirectsLeft > 0) {
        const location = response.headers.get("location");
        if (location) {
          currentUrl = location.startsWith("http")
            ? location
            : new URL(location, currentUrl).toString();
          redirectsLeft--;
          // For redirects, switch to GET and drop body per HTTP spec
          method = "GET";
          body = undefined;
          delete headers["content-length"];
          continue;
        }
      }

      // Normalize response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });

      // Stream mode: pump body into a PassThrough eagerly so data flows immediately
      if (stream) {
        const webStream = response.body;
        const body = new PassThrough();
        (async () => {
          if (!webStream) {
            body.end();
            return;
          }
          const reader = webStream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              body.push(Buffer.from(value));
            }
            body.end();
          } catch (err) {
            body.destroy(err as Error);
          } finally {
            reader.releaseLock();
          }
        })();
        return { status: response.status, headers: responseHeaders, body };
      }

      // Deserialize body
      const contentType = responseHeaders["content-type"] ?? "";
      let responseBody: unknown;

      if (contentType.includes("application/json")) {
        const text = await response.text();
        responseBody = text.length === 0 ? null : JSON.parse(text);
      } else {
        responseBody = await response.text();
      }

      return { status: response.status, headers: responseHeaders, body: responseBody };
    }
  } catch (err) {
    // Caller cancellation (not the timeout) surfaces as the structured invoke
    // cancellation rather than masquerading as a network TIMEOUT.
    if (callerSignal?.aborted) {
      throw new InvokeError(ERR_INVOKE_CANCELLED, "Request cancelled");
    }
    mapNetworkError(err, url);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function executeWithRetry(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeout: number,
  retriesLeft: number,
  stream = false,
  callerSignal?: AbortSignal,
): Promise<TeloResponse> {
  try {
    return await executeRequest(url, method, headers, body, timeout, stream, callerSignal);
  } catch (err) {
    if (retriesLeft > 0 && (err as any).error === "NetworkError") {
      return executeWithRetry(
        url,
        method,
        headers,
        body,
        timeout,
        retriesLeft - 1,
        stream,
        callerSignal,
      );
    }
    throw err;
  }
}

interface HttpRequestInputs {
  url: string;
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
}

interface HttpRequestManifest extends HttpRequestInputs {
  // `client` is an x-telo-ref slot, so its runtime shape depends on where the
  // Http.Request sits. See resolveClientConfig for the forms it can take.
  client?: unknown;
  timeout?: number;
  throwOnHttpError?: boolean;
  retries?: number;
  mode?: "buffer" | "stream";
  inputs?: HttpRequestInputs;
}

interface ClientSnapshotInstance {
  snapshot: () => Record<string, unknown>;
}

function hasSnapshot(value: unknown): value is ClientSnapshotInstance {
  return !!value && typeof (value as { snapshot?: unknown }).snapshot === "function";
}

/**
 * Normalize the `client` x-telo-ref value to a `{ name, alias? }` lookup.
 *
 * The value's shape depends on where the Http.Request sits:
 *   - Inline inside a scope (e.g. a Run.Sequence step's `invoke:`) hits the kernel's
 *     hidden-slot limitation (see resource-context.ts), so the reference arrives
 *     unresolved — a `!ref` sentinel or a `{kind, name, alias?}` object.
 *   - A bare resource-name string is still accepted by the analyzer as a legacy name
 *     reference, so it stays supported here.
 *
 * `{kind, name, alias?}` objects are read directly rather than routed through
 * `ctx.resolveChildren`: an `alias` key there registers a spurious inline manifest and
 * drops the alias. Sentinels still go through `resolveChildren`, which performs the
 * Self./Alias. split and cross-module export resolution.
 */
function normalizeClientRef(
  client: unknown,
  ctx: ResourceContext,
): { name: string; alias?: string } {
  if (typeof client === "string") return { name: client };
  if (client && typeof client === "object") {
    const ref = client as Record<string, unknown>;
    if (typeof ref.name === "string") {
      return { name: ref.name, alias: typeof ref.alias === "string" ? ref.alias : undefined };
    }
    const resolved = ctx.resolveChildren(client) as { name: string; alias?: string };
    return { name: resolved.name, alias: resolved.alias };
  }
  throw new Error(
    "Http.Request: 'client' must reference an Http.Client (use 'client: !ref MyClient').",
  );
}

/**
 * Resolve the `client` x-telo-ref slot to its config (baseUrl / headers / timeout).
 * The returned config may still carry `${{ }}` expressions; the caller expands them.
 */
function resolveClientConfig(client: unknown, ctx: ResourceContext): Record<string, unknown> {
  // Top-level Http.Request: the kernel injects the live Http.Client instance at Phase 5.
  if (hasSnapshot(client)) return client.snapshot();

  const { name, alias } = normalizeClientRef(client, ctx);

  // Cross-module reference into an imported library's exported Http.Client instance.
  if (alias && alias !== "Self") {
    const instance = ctx.moduleContext.resolveImportedInstance(alias, name);
    if (!hasSnapshot(instance)) {
      throw new Error(
        `Http.Request: client reference '${alias}.${name}' did not resolve to an imported Http.Client instance.`,
      );
    }
    return instance.snapshot();
  }

  // Local reference. Prefer the live instance: a kind that inherits Http.Client
  // by `extends` (general single inheritance) is a delegated Client whose
  // snapshot() carries the resolved baseUrl/headers — its raw manifest holds the
  // child's own config (e.g. `host`), not a Client config. Only fall back to the
  // raw manifest for a genuine Http.Client at a scope site where no live instance
  // is registered.
  const live = ctx.moduleContext.resourceInstances.get(name)?.instance;
  if (hasSnapshot(live)) return live.snapshot();
  const resource = ctx.getResourcesByName("Client", name);
  if (!resource) {
    throw new Error(`Http.Request: Http.Client "${name}" not found.`);
  }
  return resource as unknown as Record<string, unknown>;
}

class HttpRequestResource implements ResourceInstance {
  constructor(
    private readonly manifest: HttpRequestManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(
    input: any,
    invokeCtx?: InvokeContext,
  ): Promise<TeloResponse | { output: Stream<Uint8Array> }> {
    const ctx = this.ctx;
    const m = this.manifest;

    // Resolve client config
    let clientBaseUrl = "";
    let clientHeaders: Record<string, string> = {};
    let clientTimeout = DEFAULT_TIMEOUT;

    if (m.client) {
      const clientConfig = resolveClientConfig(m.client, ctx);

      const resolvedBaseUrl = ctx.expandValue(clientConfig.baseUrl ?? "", input ?? {});
      clientBaseUrl = typeof resolvedBaseUrl === "string" ? resolvedBaseUrl : "";

      const resolvedHeaders = ctx.expandValue(clientConfig.headers ?? {}, input ?? {});
      clientHeaders = normalizeHeaders((resolvedHeaders ?? {}) as Record<string, string>);

      const resolvedTimeout = ctx.expandValue(clientConfig.timeout ?? DEFAULT_TIMEOUT, input ?? {});
      clientTimeout =
        typeof resolvedTimeout === "number" && Number.isFinite(resolvedTimeout)
          ? resolvedTimeout
          : DEFAULT_TIMEOUT;
    }

    // Build the effective inputs by layering, lowest precedence to highest:
    //   1. manifest-level fields (url, method, ...) — fallback defaults
    //   2. m.inputs — manifest-baked inputs (legacy, still supported when present)
    //   3. call-site `input` — the canonical sibling-form invocation args
    // CEL expressions inside any of these resolve against `input` as the context.
    const callerInput = (input ?? {}) as Record<string, unknown>;
    const manifestInputs: HttpRequestInputs = {
      url: m.url,
      method: m.method,
      query: m.query,
      headers: m.headers,
      body: m.body,
      ...m.inputs,
      ...callerInput,
    };
    const resolved = ctx.expandValue(manifestInputs, callerInput) as HttpRequestInputs;
    const rawUrl = resolved.url as string;
    const method = ((resolved.method ?? "GET") || "GET").toUpperCase();
    const requestHeaders = normalizeHeaders((resolved.headers ?? {}) as Record<string, string>);
    const query = (resolved.query ?? {}) as Record<string, string>;
    const body = resolved.body;
    const effectiveTimeout = m.timeout ?? clientTimeout;
    const retries = m.retries ?? 0;
    const throwOnHttpError = m.throwOnHttpError ?? false;

    // Build URL
    let fullUrl = rawUrl.startsWith("http") ? rawUrl : `${clientBaseUrl}${rawUrl}`;

    // Append query params
    const queryEntries = Object.entries(query);
    if (queryEntries.length > 0) {
      const params = new URLSearchParams(queryEntries);
      fullUrl = `${fullUrl}${fullUrl.includes("?") ? "&" : "?"}${params.toString()}`;
    }

    // Merge headers: client defaults < request-specific
    const mergedHeaders: Record<string, string> = { ...clientHeaders, ...requestHeaders };

    // Serialize body
    let serializedBody: string | undefined;
    if (body !== undefined) {
      if (typeof body === "object" && body !== null) {
        const contentType = mergedHeaders["content-type"] ?? "application/json";
        if (!mergedHeaders["content-type"]) {
          mergedHeaders["content-type"] = "application/json";
        }
        if (contentType.includes("application/x-www-form-urlencoded")) {
          serializedBody = new URLSearchParams(body as Record<string, string>).toString();
        } else {
          // Default to JSON
          mergedHeaders["content-type"] = mergedHeaders["content-type"] ?? "application/json";
          serializedBody = JSON.stringify(body);
        }
      } else {
        serializedBody = String(body);
      }
    }

    const response = await executeWithRetry(
      fullUrl,
      method,
      mergedHeaders,
      serializedBody,
      effectiveTimeout,
      retries,
      m.mode === "stream",
      invokeCtx?.cancellation.signal,
    );

    if (throwOnHttpError && response.status >= 400) {
      throw new Error(`HTTP ${response.status} error from ${fullUrl}`);
    }

    if (m.mode === "stream") {
      // Wrap the upstream Readable in a Stream so the value's constructor is
      // recognized by CEL and the result fits the streaming-Invocable
      // convention ({output: Stream<...>}). HTTP server consumers pipe through
      // a format-codec encoder (Octet.Encoder for raw bytes) to write to the
      // response.
      return { output: new Stream(response.body as Readable) };
    }

    return response;
  }
}

export function register(): void {}

export async function create(
  resource: HttpRequestManifest,
  ctx: ResourceContext,
): Promise<HttpRequestResource> {
  return new HttpRequestResource(resource, ctx);
}
