import type { DpopKey } from "./dpop-key.js";
import { answerMayBeLost, failureCause } from "./request-failure.js";

/** How long one token request may take, nonce resend included. */
export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/** A successful token response, as far as the CLI reads it. */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

export type TokenAnswer =
  | { kind: "tokens"; body: TokenResponse; sentAt: number }
  /** The endpoint answered an OAuth error, or a status with none. */
  | { kind: "refused"; status: number; error: string | undefined; description: string | undefined }
  /** No answer arrived; `mayBeLost` when the request may have been acted on. */
  | { kind: "unreachable"; cause: string; mayBeLost: boolean };

/**
 * The token endpoint of one issuer, with the DPoP nonce it last handed out
 * (RFC 9449 §8), which every later proof to it carries.
 */
export class TokenEndpoint {
  private nonce: string | undefined;

  constructor(
    readonly url: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /**
   * One token request signed by `key`. A `use_dpop_nonce` answer is sent again
   * once with the nonce it carries: that is the protocol, not a retry. Rejects
   * only with `signal`'s reason.
   */
  async request(
    form: Record<string, string | readonly string[]>,
    key: DpopKey,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<TokenAnswer> {
    const deadline = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(form)) {
      for (const one of typeof value === "string" ? [value] : value) body.append(name, one);
    }
    let resentForNonce = false;
    for (;;) {
      const sentAt = Date.now();
      let response: Response;
      let text: string;
      let parsed: unknown;
      try {
        response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
            dpop: key.proof({ htm: "POST", htu: this.url, ...(this.nonce === undefined ? {} : { nonce: this.nonce }) }),
          },
          body: body.toString(),
          signal: deadline,
        });
        const nonce = response.headers.get("dpop-nonce");
        if (nonce) this.nonce = nonce;
        text = await response.text();
      } catch (error) {
        options.signal.throwIfAborted();
        return { kind: "unreachable", cause: failureCause(error), mayBeLost: answerMayBeLost(error) };
      }
      try {
        parsed = text === "" ? undefined : JSON.parse(text);
      } catch {
        // A success whose body cannot be read is an answer lost after the grant moved.
        if (response.ok) return { kind: "unreachable", cause: "its answer is not JSON", mayBeLost: true };
        parsed = undefined;
      }
      const document = isObject(parsed) ? parsed : {};
      if (response.ok) {
        if (typeof document.access_token !== "string" || typeof document.token_type !== "string" || typeof document.expires_in !== "number") {
          return { kind: "refused", status: response.status, error: undefined, description: "the answer carries no access token" };
        }
        return { kind: "tokens", body: document as unknown as TokenResponse, sentAt };
      }
      const error = typeof document.error === "string" ? document.error : undefined;
      if (error === "use_dpop_nonce" && !resentForNonce && response.headers.get("dpop-nonce")) {
        resentForNonce = true;
        continue;
      }
      if (response.status === 502 || response.status === 504) {
        return { kind: "unreachable", cause: `it answered ${response.status} ${response.statusText}`.trimEnd(), mayBeLost: true };
      }
      return {
        kind: "refused",
        status: response.status,
        error,
        description: typeof document.error_description === "string" ? document.error_description : undefined,
      };
    }
  }
}

/** A refusal in the issuer's own words. */
export function refusalText(answer: Extract<TokenAnswer, { kind: "refused" }>): string {
  if (answer.error !== undefined) return answer.description ? `${answer.error}: ${answer.description}` : answer.error;
  return answer.description ? `${answer.status}: ${answer.description}` : `it answered ${answer.status}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
