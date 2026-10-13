import { base64UrlDecode, base64UrlEncode, randomToken } from "@/base64url";
import { dpopProof, generateDpopKey } from "@/dpop-proof";

/** The identity provider and this site's registration there. The endpoints are
 *  fixed paths under the issuer, as studio's shell reads them. */
export interface OidcClient {
  issuer: string;
  clientId: string;
  siteOrigin: string;
}

export const CALLBACK_PATH = "/auth/callback";
export const SILENT_PATH = "/auth/silent";

const SCOPE = "openid profile email";

export interface SessionUser {
  id: string;
  name: string | null;
  email: string | null;
}

export interface SessionIdentity {
  user: SessionUser;
  /** Kept only to tell the provider which session a sign-out ends. */
  idToken: string;
  /** Epoch milliseconds at which the provider is asked again. */
  expiresAt: number;
}

/** What one authorization request must remember until its response arrives. */
export interface PendingAuthorization {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
}

/** A sign-in that did not end in an identity. `code` is the provider's OAuth
 *  error code when it sent one. */
export class SignInError extends Error {
  override name = "SignInError";
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function beginAuthorization(
  client: OidcClient,
  redirectPath: string,
  prompt?: "none",
): Promise<{ url: string; pending: PendingAuthorization }> {
  const pending: PendingAuthorization = {
    state: randomToken(),
    nonce: randomToken(),
    codeVerifier: randomToken(),
    redirectUri: client.siteOrigin + redirectPath,
  };
  const challenge = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(pending.codeVerifier),
  );
  const url = new URL(`${client.issuer}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: pending.redirectUri,
    scope: SCOPE,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: base64UrlEncode(new Uint8Array(challenge)),
    code_challenge_method: "S256",
    ...(prompt ? { prompt } : {}),
  }).toString();
  return { url: url.href, pending };
}

/** Redeems the authorization response in `search` (the redirect's query string)
 *  for the identity it stands for. */
export async function redeemAuthorization(
  client: OidcClient,
  pending: PendingAuthorization,
  search: string,
): Promise<SessionIdentity> {
  const response = new URLSearchParams(search);
  if (response.get("state") !== pending.state) {
    throw new SignInError("The sign-in response does not belong to this sign-in.");
  }
  // RFC 9207: the response names who sent it.
  if (response.get("iss") !== client.issuer) {
    throw new SignInError("The sign-in response did not come from the identity provider.");
  }
  const error = response.get("error");
  if (error) {
    throw new SignInError(response.get("error_description") ?? `The sign-in was refused: ${error}.`, error);
  }
  const code = response.get("code");
  if (!code) throw new SignInError("The sign-in response carries no authorization code.");

  const tokens = await requestTokens(client, pending, code);
  const user = readIdToken(client, pending, tokens.id_token);
  return { user, idToken: tokens.id_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
}

interface TokenResponse {
  id_token: string;
  expires_in: number;
}

async function requestTokens(
  client: OidcClient,
  pending: PendingAuthorization,
  code: string,
): Promise<TokenResponse> {
  const endpoint = `${client.issuer}/oauth2/token`;
  const key = await generateDpopKey();
  const send = async (nonce?: string) =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        DPoP: await dpopProof(key, { method: "POST", url: endpoint, nonce }),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
        client_id: client.clientId,
      }),
    });

  // A body that is not JSON is reported below by its status.
  const read = async (answer: Response): Promise<unknown> => answer.json().catch(() => null);
  const refusalOf = (body: unknown) => (body as { error?: unknown } | null)?.error;

  let response: Response;
  let body: unknown;
  try {
    response = await send();
    body = await read(response);
    // RFC 9449 §8: the server hands out the nonce it wants in the proof.
    const nonce = response.headers.get("DPoP-Nonce");
    if (refusalOf(body) === "use_dpop_nonce" && nonce) {
      response = await send(nonce);
      body = await read(response);
    }
  } catch (cause) {
    throw new SignInError(
      `The identity provider could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (!response.ok) {
    const refusal = refusalOf(body);
    throw new SignInError(
      typeof refusal === "string"
        ? `The identity provider refused the authorization code: ${refusal}.`
        : `The identity provider's token endpoint answered ${response.status}.`,
      typeof refusal === "string" ? refusal : undefined,
    );
  }
  const tokens = body as Partial<TokenResponse> | null;
  if (typeof tokens?.id_token !== "string" || typeof tokens.expires_in !== "number" || tokens.expires_in <= 0) {
    throw new SignInError("The identity provider's token response is malformed.");
  }
  return { id_token: tokens.id_token, expires_in: tokens.expires_in };
}

/** The ID token arrived straight from the token endpoint over TLS, so its
 *  claims are checked and its signature is not (OpenID Connect Core §3.1.3.7). */
function readIdToken(client: OidcClient, pending: PendingAuthorization, idToken: string): SessionUser {
  const malformed = new SignInError("The identity provider's ID token is malformed.");
  const payload = idToken.split(".")[1];
  if (!payload) throw malformed;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    throw malformed;
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== client.issuer ||
    !audience.includes(client.clientId) ||
    claims.nonce !== pending.nonce ||
    typeof claims.exp !== "number" ||
    claims.exp * 1000 <= Date.now() ||
    typeof claims.sub !== "string"
  ) {
    throw new SignInError("The identity provider's ID token was not issued for this sign-in.");
  }
  return {
    id: claims.sub,
    name: typeof claims.name === "string" ? claims.name : null,
    email: typeof claims.email === "string" ? claims.email : null,
  };
}

/** Where a sign-out sends the browser: the provider ends its own session and
 *  returns to the home page. */
export function endSessionUrl(client: OidcClient, idToken: string): string {
  const url = new URL(`${client.issuer}/oauth2/end-session`);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    id_token_hint: idToken,
    post_logout_redirect_uri: `${client.siteOrigin}/`,
  }).toString();
  return url.href;
}
