import { PassThrough, Readable } from "stream";
import type { ResourceContext, ResourceInstance } from "@telorun/sdk";

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
): Promise<TeloResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let currentUrl = url;
  let redirectsLeft = MAX_REDIRECTS;

  try {
    while (true) {
      const response = await fetch(currentUrl, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
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
): Promise<TeloResponse> {
  try {
    return await executeRequest(url, method, headers, body, timeout, stream);
  } catch (err) {
    if (retriesLeft > 0 && (err as any).error === "NetworkError") {
      return executeWithRetry(url, method, headers, body, timeout, retriesLeft - 1, stream);
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
  client?: string;
  timeout?: number;
  throwOnHttpError?: boolean;
  retries?: number;
  mode?: "buffer" | "stream";
  inputs?: HttpRequestInputs;
}

class HttpRequestResource implements ResourceInstance {
  constructor(
    private readonly manifest: HttpRequestManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: any): Promise<TeloResponse | Readable> {
    const ctx = this.ctx;
    const m = this.manifest;

    // Resolve client config
    let clientBaseUrl = "";
    let clientHeaders: Record<string, string> = {};
    let clientTimeout = DEFAULT_TIMEOUT;

    if (m.client) {
      const clientName = ctx.expandValue(m.client, input ?? {}) as string;
      const client: any = ctx.getResourcesByName("Client", clientName);
      if (!client) {
        throw new Error(`Http.Client "${clientName}" not found`);
      }

      clientBaseUrl = client.baseUrl ?? "";
      clientHeaders = normalizeHeaders(client.headers ?? {});
      clientTimeout = client.timeout ?? DEFAULT_TIMEOUT;
    }

    // Expand template fields from manifest.inputs using runtime input as context
    // Manifest-level fields (url, method, etc.) serve as defaults when inputs is absent
    const manifestInputs: HttpRequestInputs = {
      url: m.url,
      method: m.method,
      query: m.query,
      headers: m.headers,
      body: m.body,
      ...m.inputs,
    };
    const resolved = ctx.expandValue(manifestInputs, input ?? {}) as HttpRequestInputs;
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
    );

    if (throwOnHttpError && response.status >= 400) {
      throw new Error(`HTTP ${response.status} error from ${fullUrl}`);
    }

    if (m.mode === "stream") {
      return response.body as Readable;
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
