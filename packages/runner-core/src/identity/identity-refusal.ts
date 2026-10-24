/** The two RFC 6750 / RFC 9449 error codes an identity request is refused with. */
export type IdentityErrorCode = "invalid_token" | "invalid_dpop_proof";

/** An access token or a DPoP proof that does not hold: answered `401`. */
export class IdentityRefusal extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** An issuer whose keys the runner cannot obtain, with no usable cache:
 *  answered `503 identity_provider_unavailable`. */
export class IdentityProviderUnavailable extends Error {
  constructor(
    readonly issuer: string,
    message: string,
  ) {
    super(message);
  }
}
