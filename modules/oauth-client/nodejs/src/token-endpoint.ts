import { ERR_INVOKE_CANCELLED, InvokeError, integerInput, RuntimeError } from "@telorun/sdk";
import type { ClientResource } from "./client.js";
import { parseTokenSet, TokenEndpointError, type TokenSet } from "./token-set.js";

/**
 * Run a request under a deadline, and under the caller's cancellation if it has
 * one. Every outbound call in this module goes through here — a provider that
 * accepts the connection and never answers must not hang an operation forever.
 */
export async function withDeadline<T>(
  url: string,
  /** The AuthorizationServer provider declares this `type: integer`, so it
   *  crosses that contract as an int64 — `setTimeout` refuses one. Read through
   *  `integerInput`, which accepts either representation. */
  timeoutMs: number | bigint,
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ms = integerInput(timeoutMs);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ms);
  const signal = callerSignal
    ? AbortSignal.any([deadline.signal, callerSignal])
    : deadline.signal;
  try {
    return await run(signal);
  } catch (err) {
    if (callerSignal?.aborted) {
      throw new InvokeError(ERR_INVOKE_CANCELLED, "Cancelled while waiting for the OAuth server");
    }
    if (deadline.signal.aborted) {
      throw new RuntimeError(
        "ERR_OAUTH_TIMEOUT",
        `No response from ${url} within ${ms}ms. Raise 'timeout' on the AuthorizationServer if the provider is legitimately this slow.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST a grant request to the token endpoint, authenticating the client the way
 * it declared. One place, because every grant — code, refresh, client
 * credentials, device — differs only in the form fields it sends.
 */
export async function postToTokenEndpoint(
  client: ClientResource,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const { tokenEndpoint, timeoutMs } = await client.endpoints();
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };

  const secret = client.clientSecret;
  switch (client.authMethod) {
    case "client_secret_basic":
      if (secret === null) {
        // Falling back silently would send the id in the body against a server
        // that asked for Basic, and the resulting 401 would say nothing useful.
        throw new RuntimeError(
          "ERR_OAUTH_CLIENT_SECRET_REQUIRED",
          "tokenEndpointAuthMethod is 'client_secret_basic' but no clientSecret is set. " +
            "Set one, or use 'none' for a public client that relies on PKCE.",
        );
      }
      headers.authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(client.clientId)}:${encodeURIComponent(secret)}`,
      ).toString("base64")}`;
      break;
    case "client_secret_post":
      body.set("client_id", client.clientId);
      if (secret !== null) body.set("client_secret", secret);
      break;
    case "none":
      body.set("client_id", client.clientId);
      break;
  }

  // A refresh runs under a claim on the grant key, so a request that never returns
  // would hold that key until its TTL lapses while the caller waits forever.
  const response = await withDeadline(tokenEndpoint, timeoutMs, signal, (requestSignal) =>
    fetch(tokenEndpoint, { method: "POST", headers, body, signal: requestSignal }),
  );
  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new RuntimeError(
      "ERR_OAUTH_MALFORMED_RESPONSE",
      `Token endpoint ${tokenEndpoint} returned HTTP ${response.status} with a body that is not JSON.`,
    );
  }

  if (!response.ok || typeof payload.error === "string") {
    const error = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    const description =
      typeof payload.error_description === "string" ? payload.error_description : null;
    throw new TokenEndpointError(error, description, response.status);
  }
  return payload;
}

/** A grant request whose successful response is a token set. */
export async function requestTokens(
  client: ClientResource,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<TokenSet> {
  const payload = await postToTokenEndpoint(client, params, signal);
  return parseTokenSet(payload, Date.now());
}

/**
 * Verify the issuer of an authorization response (RFC 9207) against the declared
 * one. Returns a refusal reason, or null when it is acceptable.
 *
 * A server that advertises it sends the parameter and then does not is refused:
 * treating the absence as "nothing to check" is precisely the hole a mix-up
 * attack walks through.
 */
export function issuerRefusal(
  endpoints: { issuer: string; issuerParameterSupported: boolean },
  iss: string | null | undefined,
): "issuer_mismatch" | "issuer_missing" | null {
  if (iss) return iss === endpoints.issuer ? null : "issuer_mismatch";
  return endpoints.issuerParameterSupported ? "issuer_missing" : null;
}

/** Scopes are sent space-delimited, per RFC 6749 §3.3. */
export function scopeParam(scopes: string[]): string | null {
  return scopes.length > 0 ? scopes.join(" ") : null;
}
