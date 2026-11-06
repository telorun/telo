import { InvokeError, resolveInvocableDispatcher, type InvokeContext, type ResourceContext } from "@telorun/sdk";
import { isRecord } from "./claim-readers.js";

export const ERR_AUTH_BEARER_INTROSPECTION_UNREACHABLE = "ERR_AUTH_BEARER_INTROSPECTION_UNREACHABLE";

export interface IntrospectionEndpoint {
  describe: string;
  url: string;
  client: unknown;
  timeoutMs: number;
}

/** What `Http.Credential` hands back to merge into the request. */
interface CredentialGrant {
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

function unreachable(endpoint: IntrospectionEndpoint, detail: string, cause?: unknown): InvokeError {
  return new InvokeError(
    ERR_AUTH_BEARER_INTROSPECTION_UNREACHABLE,
    `${endpoint.describe}: introspection endpoint ${detail}`,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Asks the endpoint about `token` (RFC 7662 §2.1), authenticating the call
 * through the `client` credential. Every way of not getting an answer rejects
 * with `ERR_AUTH_BEARER_INTROSPECTION_UNREACHABLE`; the answer itself, active or
 * not, is returned.
 */
export async function introspect(
  ctx: ResourceContext,
  endpoint: IntrospectionEndpoint,
  token: string,
  invokeCtx?: InvokeContext,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  const url = new URL(endpoint.url);
  if (endpoint.client !== undefined) {
    const credential = resolveInvocableDispatcher(endpoint.client, ctx, () => `${endpoint.describe}: 'client'`);
    const grant = (await credential(
      { request: { method: "POST", url: endpoint.url, headers: { ...headers } } },
      invokeCtx,
    )) as CredentialGrant;
    Object.assign(headers, grant.headers);
    for (const [name, value] of Object.entries(grant.query ?? {})) url.searchParams.set(name, value);
  }

  const timeout = AbortSignal.timeout(endpoint.timeoutMs);
  const signal = invokeCtx ? AbortSignal.any([timeout, invokeCtx.cancellation.signal]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: new URLSearchParams({ token, token_type_hint: "access_token" }),
      signal,
    });
  } catch (err) {
    if (invokeCtx?.cancellation.signal.aborted) throw err;
    throw unreachable(endpoint, "could not be reached", err);
  }
  if (response.status !== 200) throw unreachable(endpoint, `answered ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw unreachable(endpoint, "did not answer with JSON", err);
  }
  if (!isRecord(body)) throw unreachable(endpoint, "did not answer with a JSON object");
  return body;
}
