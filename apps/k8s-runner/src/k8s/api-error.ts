import { SessionStartError, type StartFailureStage } from "@telorun/runner-core";

/**
 * A Kubernetes API rejection, phrased for the person who clicked Run.
 *
 * `ApiException.message` is a full HTTP dump — status line, the raw `Status`
 * body and every response header — and a start failure's message travels
 * verbatim to the client as the session's terminal `failed` status. That put
 * the runner's ServiceAccount name, the request's audit id and its flowschema
 * UIDs on an end user's screen, none of which they can act on.
 *
 * So the client sees the operation, the HTTP status and the API's own one-word
 * `reason` — enough for an operator to know what was refused — and never the
 * body or the headers. The raw exception rides along as the error's `cause`,
 * which the runner's log serializer records, so nothing is swallowed: the detail
 * moves to the log, it does not disappear.
 */
export function apiFailure(
  err: unknown,
  stage: StartFailureStage,
  action: string,
): SessionStartError {
  return withCause(
    new SessionStartError("start_failed", stage, `${action}: ${apiReason(err)}`),
    err,
  );
}

/** Attach the original error as `cause` so a log serializer can reach it.
 *  Every wrap on a failure path goes through here — a rewrap that drops the
 *  cause silently undoes the whole point of summarizing the message. */
export function withCause<E extends Error>(error: E, cause: unknown): E {
  error.cause = cause;
  return error;
}

/** The client-safe half of a Kubernetes API error: what was refused, and who
 *  can act on it — never the `Status` message, which names cluster identities. */
export function apiReason(err: unknown): string {
  const code = statusCode(err);
  // No HTTP status means the request never got an answer: a refused connection,
  // a DNS failure, an abort. Those carry a `code` too (`ECONNREFUSED`, an
  // `ABORT_ERR` number), which is why `statusCode` accepts only what an HTTP
  // response could have produced — reporting `HTTP ECONNREFUSED` claimed the
  // apiserver rejected something when it was never reached, which is exactly
  // the case where the difference matters.
  if (code === undefined) return "the Kubernetes API could not be reached";

  const reason = statusReason(err);
  const detail = reason ? `${reason}, HTTP ${code}` : `HTTP ${code}`;
  const cause = refusalCause(err);
  if (cause === "quota") {
    return `the session namespace's resource quota is exhausted (${detail})`;
  }
  if (cause === "rbac") {
    return `the runner is not permitted to do this (${detail}). The cluster operator must check the runner's RBAC.`;
  }
  return `the Kubernetes API rejected the request (${detail})`;
}

/**
 * Which of the two things a `403 Forbidden` means here.
 *
 * The status code alone cannot say: an RBAC denial and a `ResourceQuota`
 * rejection are both `403` with `reason: Forbidden`, and this chart ships a
 * quota (32 pods) enabled by default — so blaming RBAC on every 403 tells the
 * operator to re-check a Role at exactly the moment the cluster is simply full.
 * The two also differ in when they happen: an RBAC 403 is an install-time
 * mistake, a quota 403 arrives under load.
 *
 * The only thing that separates them is the admission message, which is why it
 * is READ here and never echoed: the classification crosses the boundary, the
 * text does not. An unrecognized 403 degrades to the neutral wording rather than
 * to a guess.
 */
function refusalCause(err: unknown): "quota" | "rbac" | undefined {
  const code = statusCode(err);
  if (code !== 401 && code !== 403) return undefined;
  const message = statusMessage(err);
  if (message && /exceeded quota|forbidden: failed quota/i.test(message)) return "quota";
  if (!message || /\bis forbidden: User\b|\bcannot \w+ resource\b/i.test(message)) return "rbac";
  return undefined;
}

/** The API `Status` object, however the client-node deserializer left it: a
 *  parsed object for a status code it recognizes, the raw JSON text for one it
 *  does not (which is the 403 case, reported as "Unknown API Status Code!"). */
function status(err: unknown): Record<string, unknown> | undefined {
  const body = (err as { body?: unknown })?.body;
  const parsed = typeof body === "string" ? parseJson(body) : body;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
}

/** `Forbidden`, `NotFound`, `Invalid`, … — the one word safe to pass on. */
function statusReason(err: unknown): string | undefined {
  const reason = status(err)?.reason;
  return typeof reason === "string" && reason.trim() !== "" ? reason : undefined;
}

/** Read for classification only — it names cluster identities and never leaves. */
function statusMessage(err: unknown): string | undefined {
  const message = status(err)?.message;
  return typeof message === "string" ? message : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The HTTP status an error carries, or `undefined` when it carries none.
 *
 * The number check is the whole point: `code` is also where Node puts a system
 * error's string code and where a `DOMException` puts its legacy numeric one, so
 * an unreachable apiserver and an aborted request both arrive here looking like
 * a status. Only a value in the HTTP range is one.
 */
export function statusCode(err: unknown): number | undefined {
  const e = err as { statusCode?: unknown; code?: unknown; response?: { statusCode?: unknown } };
  for (const candidate of [e?.statusCode, e?.code, e?.response?.statusCode]) {
    if (typeof candidate === "number" && candidate >= 100 && candidate <= 599) return candidate;
  }
  return undefined;
}
