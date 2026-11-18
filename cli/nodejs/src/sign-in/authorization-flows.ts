import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { DpopKey } from "./dpop-key.js";
import type { IssuerEndpoints } from "./issuer-metadata.js";
import { failureCause } from "./request-failure.js";
import { sameResource } from "./runner-identity.js";
import { SignInError } from "./sign-in-error.js";
import { refusalText, TOKEN_REQUEST_TIMEOUT_MS, type TokenEndpoint, type TokenResponse } from "./token-endpoint.js";

/** How long a browser sign-in waits for the redirect back. */
export const LOOPBACK_WAIT_MS = 10 * 60_000;
/** The path of the loopback redirect, as accounts registers it (`http://127.0.0.1/callback`, any port). */
export const LOOPBACK_PATH = "/callback";

/** What a login shows the person, through the caller. */
export type SignInEvent =
  /** The page to approve the sign-in at; the browser is opened on it too. */
  | { type: "browser"; url: string }
  /** The browser could not be opened; the login continues with a device code. */
  | { type: "browser-failed"; reason: string }
  /** The code to enter, and where. */
  | { type: "device-code"; verificationUri: string; verificationUriComplete: string | undefined; userCode: string; expiresAt: Date };

/** Opens `url` in the person's browser; `onFailure` is called, possibly later, when it cannot. */
export type BrowserOpener = (url: string, onFailure: (reason: string) => void) => void;

/** One authorization of the grant: who asks, for what, bound to which key. */
export interface GrantRequest {
  endpoints: IssuerEndpoints;
  clientId: string;
  scopes: readonly string[];
  resources: readonly string[];
  /** The resource the first access token is for. */
  tokenResource: string;
  key: DpopKey;
}

/** A token response the grant was created by, and the ID token nonce it must carry. */
export interface GrantTokens {
  body: TokenResponse;
  sentAt: number;
  nonce: string | undefined;
}

interface FlowOptions {
  signal: AbortSignal;
  onEvent: (event: SignInEvent) => void;
}

/**
 * Authorization code with PKCE (S256) on a `127.0.0.1` loopback redirect, on a
 * port the OS chooses. `"browser-failed"` when the browser could not be opened.
 */
export async function loopbackSignIn(
  request: GrantRequest,
  tokens: TokenEndpoint,
  options: FlowOptions & { openBrowser: BrowserOpener; waitMs: number },
): Promise<GrantTokens | "browser-failed"> {
  const state = randomToken();
  const verifier = randomToken();
  const nonce = randomToken();
  const issuer = request.endpoints.issuer;

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}${LOOPBACK_PATH}`;
  try {
    const url = new URL(request.endpoints.authorizationEndpoint);
    const params: Array<[string, string]> = [
      ["response_type", "code"],
      ["client_id", request.clientId],
      ["redirect_uri", redirectUri],
      ["scope", request.scopes.join(" ")],
      ["state", state],
      ["nonce", nonce],
      ["code_challenge", createHash("sha256").update(verifier).digest("base64url")],
      ["code_challenge_method", "S256"],
      ["dpop_jkt", request.key.thumbprint()],
      ...request.resources.map((resource): [string, string] => ["resource", resource]),
    ];
    for (const [name, value] of params) url.searchParams.append(name, value);

    const outcome = await new Promise<{ code: string } | "browser-failed">((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SignInError("ERR_SIGN_IN_FAILED", `no sign-in arrived from ${issuer} within ${Math.round(options.waitMs / 60_000)} minutes`)),
        options.waitMs,
      );
      let settled = false;
      const settle = (): void => {
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener("abort", aborted);
      };
      const aborted = (): void => {
        settle();
        reject(options.signal.reason);
      };
      options.signal.addEventListener("abort", aborted, { once: true });
      if (options.signal.aborted) return aborted();

      server.on("request", (req, res) => {
        if (settled) return page(res, 410, "This sign-in is over. Return to the terminal.");
        const callback = new URL(req.url ?? "/", redirectUri);
        if (req.method !== "GET" || callback.pathname !== LOOPBACK_PATH) return page(res, 404, "Not found.");
        const query = callback.searchParams;
        if (query.get("state") !== state) return page(res, 400, "This sign-in link is not the one telo is waiting for.");
        const answeredIssuer = query.get("iss");
        if (answeredIssuer !== null && !sameResource(answeredIssuer, issuer)) {
          page(res, 400, "The sign-in was answered by another issuer.");
          settle();
          return reject(new SignInError("ERR_SIGN_IN_FAILED", `the sign-in was answered by ${answeredIssuer}, not ${issuer}`));
        }
        const error = query.get("error");
        if (error !== null) {
          const description = query.get("error_description");
          page(res, 400, "The sign-in did not complete. Return to the terminal for the reason.");
          settle();
          return reject(
            new SignInError(
              "ERR_SIGN_IN_FAILED",
              error === "access_denied" ? `the sign-in was denied at ${issuer}` : `${issuer} refused the sign-in: ${description ? `${error}: ${description}` : error}`,
            ),
          );
        }
        const code = query.get("code");
        if (code === null) return page(res, 400, "The sign-in answer carries no code.");
        page(res, 200, "Signed in to Telo. You can close this tab and return to the terminal.");
        settle();
        resolve({ code });
      });

      options.onEvent({ type: "browser", url: url.toString() });
      options.openBrowser(url.toString(), (reason) => {
        if (settled) return;
        settle();
        options.onEvent({ type: "browser-failed", reason });
        resolve("browser-failed");
      });
    });
    if (outcome === "browser-failed") return outcome;

    const answer = await tokens.request(
      {
        grant_type: "authorization_code",
        code: outcome.code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: request.clientId,
        resource: request.tokenResource,
      },
      request.key,
      { signal: options.signal, timeoutMs: TOKEN_REQUEST_TIMEOUT_MS },
    );
    return { ...grantTokens(answer, issuer), nonce };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The device authorization grant (RFC 8628): a code the person enters on another device. */
export async function deviceCodeSignIn(
  request: GrantRequest,
  tokens: TokenEndpoint,
  options: FlowOptions & { fetch: typeof fetch },
): Promise<GrantTokens> {
  const issuer = request.endpoints.issuer;
  const form = new URLSearchParams([
    ["client_id", request.clientId],
    ["scope", request.scopes.join(" ")],
    ["dpop_jkt", request.key.thumbprint()],
    ...request.resources.map((resource): [string, string] => ["resource", resource]),
  ]);
  let document: Record<string, unknown>;
  try {
    const response = await options.fetch(request.endpoints.deviceAuthorizationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)]),
    });
    const text = await response.text();
    document = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    if (!response.ok) {
      const error = typeof document.error === "string" ? document.error : `${response.status}`;
      const description = typeof document.error_description === "string" ? `: ${document.error_description}` : "";
      throw new SignInError("ERR_SIGN_IN_FAILED", `${issuer} refused a device code: ${error}${description}`);
    }
  } catch (error) {
    options.signal.throwIfAborted();
    if (error instanceof SignInError) throw error;
    throw new SignInError(undefined, `could not reach ${request.endpoints.deviceAuthorizationEndpoint}: ${failureCause(error)}`);
  }
  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, expires_in: expiresIn } = document;
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string" || typeof expiresIn !== "number") {
    throw new SignInError("ERR_SIGN_IN_FAILED", `${issuer} answered no usable device code`);
  }
  const complete = typeof document.verification_uri_complete === "string" ? document.verification_uri_complete : undefined;
  let intervalMs = (typeof document.interval === "number" ? document.interval : 5) * 1000;
  const expiresAt = Date.now() + expiresIn * 1000;
  options.onEvent({ type: "device-code", verificationUri, verificationUriComplete: complete, userCode, expiresAt: new Date(expiresAt) });

  for (;;) {
    await pause(Math.min(intervalMs, Math.max(0, expiresAt - Date.now())), options.signal);
    if (Date.now() >= expiresAt) {
      throw new SignInError("ERR_SIGN_IN_FAILED", `the code ${userCode} expired before it was approved at ${issuer}`);
    }
    const answer = await tokens.request(
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: request.clientId, resource: request.tokenResource },
      request.key,
      { signal: options.signal, timeoutMs: TOKEN_REQUEST_TIMEOUT_MS },
    );
    // Nothing reached accounts, so the code is still redeemable: keep polling until it expires.
    if (answer.kind === "unreachable" && !answer.mayBeLost) continue;
    if (answer.kind === "refused" && answer.error === "authorization_pending") continue;
    if (answer.kind === "refused" && answer.error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (answer.kind === "refused" && answer.error === "access_denied") {
      throw new SignInError("ERR_SIGN_IN_FAILED", `the sign-in was denied at ${issuer}`);
    }
    if (answer.kind === "refused" && answer.error === "expired_token") {
      throw new SignInError("ERR_SIGN_IN_FAILED", `the code ${userCode} expired before it was approved at ${issuer}`);
    }
    return { ...grantTokens(answer, issuer), nonce: undefined };
  }
}

/** The tokens a code exchange or a device code redemption created the grant with. */
function grantTokens(answer: Awaited<ReturnType<TokenEndpoint["request"]>>, issuer: string): Omit<GrantTokens, "nonce"> {
  if (answer.kind === "unreachable") throw new SignInError(undefined, `could not reach ${issuer}'s token endpoint: ${answer.cause}`);
  if (answer.kind === "refused") throw new SignInError("ERR_SIGN_IN_FAILED", `${issuer} refused the sign-in: ${refusalText(answer)}`);
  return { body: answer.body, sentAt: answer.sentAt };
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function page(res: http.ServerResponse, status: number, text: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>Telo</title><p>${text}</p>\n`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" });
  res.end(body);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    function aborted(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}
