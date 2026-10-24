import { signDpopProof, type DpopKey } from "./dpop-proof";

/**
 * Getting an access token for one runner from whoever holds Studio's sign-in:
 * the web build's same-origin server, or the desktop shell. The holder asks
 * the runner's own grant — never the sign-in's — and forwards the page's proof
 * with its token request, so the token and the grant are bound to this
 * installation's key. No refresh token ever reaches the page.
 */

export type RunnerTokenAnswer =
  | { kind: "token"; accessToken: string; expiresIn: number }
  /** Sign a proof for the token request to `tokenEndpoint` (with `nonce`, when
   *  the identity provider handed one out) and ask again. */
  | { kind: "proof"; tokenEndpoint: string; nonce?: string }
  /** The runner's grant was refused and deleted: the user is told, and the
   *  next exchange, with a fresh proof, authorizes the runner again. */
  | { kind: "reauthorizing"; tokenEndpoint: string; nonce?: string };

export interface RunnerTokenHolder {
  /** One exchange for an access token whose audience is `resource`. `proof` is
   *  null until the holder has named its token endpoint. */
  exchange(resource: string, proof: string | null): Promise<RunnerTokenAnswer>;
}

/** The identity provider could not be reached: retryable, and shown. */
export class IdentityProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityProviderUnavailableError";
  }
}

export interface RunnerAccessToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Exchanges in one request before the holder is taken to be looping: an
 *  unknown endpoint, a refused runner grant, an authorization, a nonce. */
const MAX_EXCHANGES = 6;

/**
 * Asks a holder for runner tokens with the signed-in subject's key. The token
 * endpoint and the last nonce are remembered, so a later request signs its
 * proof at once.
 */
export class RunnerTokenSource {
  private tokenEndpoint: string | null = null;
  private nonce: string | undefined;

  constructor(
    private readonly holder: RunnerTokenHolder,
    private readonly key: () => Promise<DpopKey>,
    private readonly now: () => number = Date.now,
    /** Told when a runner is being authorized again. */
    private readonly onReauthorizing: (resource: string) => void = () => undefined,
  ) {}

  async token(resource: string): Promise<RunnerAccessToken> {
    const key = await this.key();
    let signedNonce: string | undefined;
    for (let exchange = 0; exchange < MAX_EXCHANGES; exchange++) {
      const endpoint = this.tokenEndpoint;
      signedNonce = this.nonce;
      const proof = endpoint
        ? await signDpopProof(key, { method: "POST", url: endpoint, ...(signedNonce ? { nonce: signedNonce } : {}) }, this.now())
        : null;
      const answer = await this.holder.exchange(resource, proof);
      if (answer.kind === "token") {
        if (!answer.accessToken || !(answer.expiresIn > 0)) {
          throw new Error("The sign-in answered a runner token Studio cannot use.");
        }
        return { accessToken: answer.accessToken, expiresAt: this.now() + answer.expiresIn * 1000 };
      }
      if (!isUrl(answer.tokenEndpoint)) {
        throw new Error("The sign-in named a token endpoint that is not a URL.");
      }
      if (answer.kind === "reauthorizing") {
        this.onReauthorizing(resource);
      } else if (proof !== null && answer.nonce !== undefined && answer.nonce === signedNonce) {
        throw new Error("The identity provider refused the nonce it handed out; no runner token was issued.");
      }
      this.tokenEndpoint = answer.tokenEndpoint;
      this.nonce = answer.nonce;
    }
    throw new Error("The identity provider kept asking for a new proof; no runner token was issued.");
  }
}

function isUrl(text: unknown): text is string {
  if (typeof text !== "string") return false;
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}
