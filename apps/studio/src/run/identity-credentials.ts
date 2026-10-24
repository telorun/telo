import { signDpopProof, type DpopKey } from "./dpop-proof";
import type { RunnerCredentials } from "./runner-credentials";
import type { RunnerAccessToken } from "./runner-token";

/** A token this close to expiry is renewed before it is sent. */
export const RUNNER_TOKEN_RENEWAL_MS = 60_000;

export interface IdentityCredentialsOptions {
  /** The runner's audience: the canonical base every request is sent under. */
  resource: string;
  tokens: { token(resource: string): Promise<RunnerAccessToken> };
  key: () => Promise<DpopKey>;
  now?: () => number;
}

/**
 * The signed-in identity as a runner credential: `Authorization: DPoP <token>`
 * and a proof signed for every request (fresh `jti` and `iat`, so a retry is
 * never a replay). The access token is held in memory only, renewed 60 s
 * before it expires, and once more when the runner answers `invalid_token`.
 */
export function identityCredentials(options: IdentityCredentialsOptions): RunnerCredentials {
  const now = options.now ?? Date.now;
  let held: RunnerAccessToken | null = null;
  let renewing: Promise<RunnerAccessToken> | null = null;

  const current = async (): Promise<string> => {
    if (held && held.expiresAt - RUNNER_TOKEN_RENEWAL_MS > now()) return held.accessToken;
    renewing ??= options.tokens.token(options.resource).finally(() => {
      renewing = null;
    });
    const renewed = await renewing;
    held = renewed;
    return renewed.accessToken;
  };

  return {
    async headers({ method, url }) {
      const accessToken = await current();
      const proof = await signDpopProof(await options.key(), { method, url, accessToken }, now());
      return { authorization: `DPoP ${accessToken}`, dpop: proof };
    },
    async retry(response) {
      if (response.status !== 401 || (await refusalCode(response)) !== "invalid_token") return false;
      held = null;
      return true;
    },
  };
}

/** The OAuth error a 401 names: the `WWW-Authenticate` challenge's `error`,
 *  else the body's. */
export async function refusalCode(response: Response): Promise<string | null> {
  const challenge = response.headers.get("www-authenticate");
  const fromChallenge = challenge ? challengeParam(challenge, "error") : null;
  if (fromChallenge) return fromChallenge;
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/** One auth-param of a challenge (`error="invalid_token"`). */
export function challengeParam(challenge: string, name: string): string | null {
  const match = new RegExp(`(?:^|[\\s,])${name}="([^"]*)"`, "i").exec(challenge);
  if (match) return match[1]!;
  const bare = new RegExp(`(?:^|[\\s,])${name}=([^\\s,"]+)`, "i").exec(challenge);
  return bare ? bare[1]! : null;
}
