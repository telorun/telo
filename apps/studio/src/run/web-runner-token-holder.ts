import type { CloudTransport } from "../cloud/transport";
import { IdentityProviderUnavailableError, type RunnerTokenAnswer, type RunnerTokenHolder } from "./runner-token";

/**
 * The web build's runner tokens come from its same-origin server, which holds
 * the sign-in and each runner's own grant: `POST /api/session/runner-token`
 * with `{ resource }` and nothing else, the page's proof for the token request
 * in a `DPoP` header and the CSRF token as for every unsafe `/api` call (the
 * transport adds it). Which grant answers is the server's: the page names only
 * the runner.
 *
 *  - `200 { access_token, token_type: "DPoP", expires_in }` — the token;
 *  - `401 { error: "dpop_proof_required" | "use_dpop_nonce", token_endpoint }`,
 *    with `DPoP-Nonce` when the identity provider handed one out — sign a proof
 *    for `token_endpoint` (with that nonce) and ask again;
 *  - `409 { error: "runner_authorization_required", authorizationUrl }` — the
 *    server holds no usable grant for this runner, whether it never had one or
 *    the identity provider refused it since: a full-page navigation to the one
 *    authorization naming this runner, returning to the current address;
 *  - `503 identity_provider_unavailable` — shown, and retryable.
 */
export function webRunnerTokenHolder(
  transport: CloudTransport,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): RunnerTokenHolder {
  return {
    async exchange(resource, proof): Promise<RunnerTokenAnswer> {
      const response = await transport.request({
        method: "POST",
        path: "/session/runner-token",
        headers: proof ? { dpop: proof } : {},
        body: JSON.stringify({ resource }),
      });
      const body = (await readJson(response)) ?? {};
      const error = typeof body.error === "string" ? body.error : null;
      const message = typeof body.message === "string" ? body.message : null;

      if (response.status === 200) {
        const tokenType = typeof body.token_type === "string" ? body.token_type.toLowerCase() : null;
        if (typeof body.access_token !== "string" || typeof body.expires_in !== "number" || tokenType !== "dpop") {
          throw new Error("The sign-in answered a runner token that is not DPoP-bound; it is not used.");
        }
        return { kind: "token", accessToken: body.access_token, expiresIn: body.expires_in };
      }
      if (
        response.status === 401 &&
        (error === "dpop_proof_required" || error === "use_dpop_nonce") &&
        typeof body.token_endpoint === "string"
      ) {
        const nonce = response.headers.get("dpop-nonce");
        return { kind: "proof", tokenEndpoint: body.token_endpoint, ...(nonce ? { nonce } : {}) };
      }
      if (response.status === 409 && error === "runner_authorization_required") {
        navigate(returningHere(body.authorizationUrl));
        return new Promise<never>(() => undefined);
      }
      if (response.status === 503 && error === "identity_provider_unavailable") {
        throw new IdentityProviderUnavailableError(
          message ?? "The identity provider could not be reached for a runner token. Try again.",
        );
      }
      if (response.status === 401 && error === "session_required") {
        throw new Error("Studio is no longer signed in, so no runner token can be had.");
      }
      throw new Error(
        `A runner token could not be had${message ? `: ${message}` : ` (HTTP ${response.status}${error ? `, ${error}` : ""}).`}`,
      );
    },
  };
}

/** The authorization address with `returnTo` naming the current page. Only an
 *  address on Studio's own origin is followed: the page is never sent where an
 *  answer merely says. */
function returningHere(authorizationUrl: unknown): string {
  if (typeof authorizationUrl !== "string") {
    throw new Error("The sign-in asked for a runner authorization without saying where.");
  }
  const url = new URL(authorizationUrl, window.location.origin);
  if (url.origin !== window.location.origin) {
    throw new Error("The sign-in asked for a runner authorization on another origin; it is not followed.");
  }
  url.searchParams.set("returnTo", window.location.pathname + window.location.search + window.location.hash);
  return url.pathname + url.search;
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  if (!(response.headers.get("content-type") ?? "").includes("json")) return null;
  try {
    const body = (await response.json()) as unknown;
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
