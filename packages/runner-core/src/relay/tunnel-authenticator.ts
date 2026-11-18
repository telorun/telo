import type { IdentityVerifier } from "../identity/identity-verifier.js";
import type { ShareOwner } from "../session-store/share-store.js";

/** A DPoP-bound access token and its proof, as an upgrade or an `auth` carries them. */
export interface TunnelCredential {
  accessToken: string;
  /** The `DPoP` header's value, as received. */
  proof: string | string[] | undefined;
}

/** Who a verified tunnel credential is, and until when. */
export interface TunnelIdentity {
  owner: ShareOwner;
  /** The access token's `exp`. */
  expiresAt: Date;
}

/**
 * Verifies a tunnel's credentials. Throws `IdentityRefusal` for a credential
 * that does not hold, `IdentityProviderUnavailable` when its issuer cannot be
 * asked.
 */
export interface TunnelAuthenticator {
  /** `htu` is the `https://` form of the share's tunnel URL. */
  authenticate(credential: TunnelCredential, htu: string): Promise<TunnelIdentity>;
}

/** The tunnel authenticator over the runner's identity verifier: the same
 *  tokens, issuers and `jti` record as `/v1`, against the tunnel's `htu`. */
export function identityTunnelAuthenticator(verifier: IdentityVerifier): TunnelAuthenticator {
  return {
    async authenticate(credential, htu) {
      const { iss, sub, expiresAt } = await verifier.verify(
        { method: "GET", headers: { dpop: credential.proof } },
        credential.accessToken,
        htu,
      );
      return { owner: { kind: "identity", iss, sub }, expiresAt };
    },
  };
}
