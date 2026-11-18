/** The innermost reason a request failed, in the runtime's words. */
export function failureCause(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "it did not answer in time";
    return error.cause instanceof Error ? error.cause.message : error.message;
  }
  return String(error);
}

/** Failures that happen before a request leaves this machine: nothing reached the server. */
const NOT_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_INVALID_URL",
]);

/**
 * Whether a request that failed may have reached the server and been acted on,
 * its answer lost: a timeout, a reset or a closed socket. A failure to connect,
 * to resolve the host or to agree on TLS never sent the request.
 */
export function answerMayBeLost(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === "TimeoutError") return true;
  const cause = error.cause as NodeJS.ErrnoException | undefined;
  const code = cause?.code ?? (error as NodeJS.ErrnoException).code;
  if (code === undefined) return true;
  if (NOT_SENT.has(code)) return false;
  return !/^(ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/.test(code);
}
