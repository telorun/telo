import { isCancellationError } from "./cancellation.js";
import { InvokeError } from "./invoke-error.js";

/** Raised when a request never reached the peer — DNS, connect, reset, or TLS
 *  trust. Distinct from a non-OK HTTP response, which is a reply the caller
 *  interprets itself. */
export const ERR_NETWORK_UNREACHABLE = "ERR_NETWORK_UNREACHABLE";

/** The facts a transport failure carries. Deliberately structured rather than
 *  pre-rendered: a controller reports *what happened*, and whoever displays the
 *  error turns it into a sentence. Prose baked into a controller would have to
 *  be re-typed identically by every language SDK (TS, Rust, Go, …) and would
 *  drift; `cause: "ENOTFOUND"` is the same symbol in every language.
 *
 *  `message` on the thrown error is a reasonable default for today's renderers;
 *  a kernel-side renderer can format from these fields instead. */
export interface NetworkErrorData {
  /** What was being attempted, e.g. `"Embedding model request"`. */
  operation: string;
  url: string;
  host: string;
  port?: number;
  /** The OS/undici code — `ENOTFOUND`, `ECONNREFUSED`, `CERT_HAS_EXPIRED`, … */
  cause: string;
  /** The underlying error's own message, kept verbatim. Carries detail no code
   *  mapping has (`SSL alert number 80`, a resolver's remarks), so wrapping is
   *  never a downgrade on an unmapped code. */
  detail?: string;
  /** `metadata.name` of the resource whose configuration produced `url`, so the
   *  error names the actual instance rather than its kind. */
  resource?: string;
  /** The setting to change — a manifest field (`baseUrl`) or a CLI/env name
   *  (`--registry`). Structured rather than a pre-written sentence: this is the
   *  one genuinely actionable part, and prose here would be the thing every
   *  other language SDK has to retype and keep in sync. */
  setting?: string;
}

/** Human explanation per transport failure code. Interpolates only the facts
 *  already in `NetworkErrorData`, so a renderer in another language can produce
 *  the same sentence from the same fields. */
function explain(code: string, host: string, port?: number): string {
  const target = port ? `${host}:${port}` : host;
  switch (code) {
    case "ENOTFOUND":
      return `DNS lookup failed for host '${host}' — the name does not resolve`;
    case "EAI_AGAIN":
      return `DNS is temporarily unavailable resolving '${host}' — a transient resolver failure`;
    case "ECONNREFUSED":
      return `nothing is listening on ${target}`;
    case "ECONNRESET":
      return `the connection to ${target} was reset by the peer`;
    case "EHOSTUNREACH":
      return `no network route to ${host}`;
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return `the connection to ${target} timed out`;
    case "CERT_HAS_EXPIRED":
      return `the TLS certificate presented by ${host} has expired`;
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return `the TLS certificate presented by ${host} is self-signed and not trusted`;
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return `the TLS certificate chain presented by ${host} could not be verified`;
    case "EPROTO":
      return `the TLS handshake with ${host} failed`;
    default:
      return `the request to ${target} failed at the transport layer`;
  }
}

/** The deepest `message` in the cause chain — the one carrying detail a code
 *  mapping cannot have. Skips undici's own `"fetch failed"`, which is the
 *  placeholder this whole module exists to replace. */
function causeDetail(err: unknown): string | undefined {
  let current: unknown = err;
  let detail: string | undefined;
  for (let depth = 0; current && depth < 5; depth++) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && message && message !== "fetch failed") detail = message;
    current = (current as { cause?: unknown }).cause;
  }
  return detail;
}

/**
 * Walk the cause chain for the first `code` — undici wraps the real error one or
 * more levels down, which is exactly the detail lost when only `message` is
 * reported.
 *
 * Exported because classifying a network failure by substring-matching the
 * message does not work: `fetch` rejects with the literal text `"fetch failed"`
 * for DNS, refusal, and TLS alike, so a `message.includes("enotfound")` test
 * silently never matches and every failure collapses into whichever branch is
 * last. Callers with their own error contract should classify on this code
 * rather than on prose.
 */
export function networkCauseCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * `fetch` that turns a transport-level failure into an {@link InvokeError}
 * carrying {@link NetworkErrorData}, instead of undici's opaque
 * `TypeError: fetch failed` whose real cause sits unread on `error.cause`.
 *
 * Only *transport* failures are wrapped. A non-OK response is returned
 * untouched, because a status code is a reply the caller interprets (and often
 * renders from the provider's own error body) — so this drops into an existing
 * call site without changing status handling. Cancellation is re-thrown as-is:
 * an aborted request is the caller's intent, not a network fault.
 *
 * @param context.operation What is being attempted, for the message.
 * @param context.resource `metadata.name` of the resource whose configuration
 *   produced the URL, so the error names the instance, not just its kind.
 * @param context.setting The manifest field or CLI/env name to change. Passed
 *   as a bare identifier, never a sentence — the wording is composed here, in
 *   one place, so another language's SDK supplies the same two facts rather
 *   than retyping the same English.
 */
export async function fetchOrThrow(
  input: string | URL,
  init: RequestInit | undefined,
  context: { operation: string; resource?: string; setting?: string },
): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  try {
    return await fetch(input, init);
  } catch (err) {
    if (isCancellationError(err)) throw err;
    if (err instanceof DOMException && err.name === "AbortError") throw err;

    const code = networkCauseCode(err) ?? "UNKNOWN";
    let host = url;
    let port: number | undefined;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      if (parsed.port) port = Number(parsed.port);
    } catch {
      // Non-absolute URL — fall back to the raw string as the host label.
    }

    const detail = causeDetail(err);
    const data: NetworkErrorData = { operation: context.operation, url, host, cause: code };
    if (port !== undefined) data.port = port;
    if (detail) data.detail = detail;
    if (context.resource) data.resource = context.resource;
    if (context.setting) data.setting = context.setting;

    // `detail` is appended only when the code has no mapping of its own —
    // otherwise the explanation already says it better. Without this, wrapping
    // an unmapped code would *lose* information relative to the raw error.
    const explained = explain(code, host, port);
    const isMapped = !explained.startsWith("the request to");
    const because = isMapped || !detail ? explained : `${explained} (${detail})`;

    const fix = context.setting
      ? ` Check \`${context.setting}\`${context.resource ? ` on resource '${context.resource}'` : ""}.`
      : "";

    const message =
      `${context.operation} failed: cannot reach ${url} — ${code}: ${because}.${fix}`;

    // The wrapped error stays reachable as `cause`: the code mapping is a
    // convenience, never a reason to destroy what was actually thrown.
    throw new InvokeError(ERR_NETWORK_UNREACHABLE, message, data, { cause: err });
  }
}
