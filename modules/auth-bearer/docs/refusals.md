# Refusals and challenges

A refusal is `{ refused: true, reason, challenge }`. `reason` is for logs and operators; `challenge` is `{ scheme, parameters }` for the `WWW-Authenticate` header.

The scheme is `Bearer`, or `DPoP` when the verifier requires DPoP or the token is DPoP-bound; a `DPoP` challenge also carries `algs`, the proof algorithms. `error` is `invalid_token` (RFC 6750), or `invalid_dpop_proof` (RFC 9449) for a proof failure. `error_description` is fixed text per reason and never repeats anything from the token.

| Reason | Meaning |
| --- | --- |
| `malformed` | Not a JWT. |
| `algorithm` | The signing algorithm is not in `algorithms`. |
| `unknownKey` | No trusted key matches the token's `kid` and algorithm. |
| `signature` | The signature does not verify. |
| `expired` | `exp` has passed. |
| `notBefore` | `nbf` is in the future. |
| `issuer` | `iss` is not the configured issuer. |
| `audience` | `aud` does not include an audience of this resource. |
| `type` | The `typ` header is not in `types`. |
| `claims` | A required claim is missing, a claim has the wrong shape, or a revocable token has no `jti`. |
| `inactive` | The introspection endpoint answered `active: false`. |
| `revoked` | The `jti` is on the denylist. |
| `dpopRequired` | DPoP is required and the token is not DPoP-bound. |
| `dpopInvalid` | The DPoP proof is missing or fails a check. |
| `dpopReplayed` | The proof's `jti` was already used. |
| `confirmationMismatch` | The token's certificate or key binding does not match the presenter, or cannot be checked. |

## Throws

| Code | When |
| --- | --- |
| `ERR_JOSE_REMOTE_KEYS_UNREACHABLE`, `ERR_JOSE_KEYSET_UNAVAILABLE` | `Jwt`: the keys could not be read. |
| `ERR_AUTH_BEARER_INTROSPECTION_UNREACHABLE` | `Introspection`: no usable answer from the endpoint. |
| `ERR_AUTH_BEARER_PRINCIPAL_INVALID`, `ERR_AUTH_BEARER_AUDIENCE_INVALID` | An expression evaluated to the wrong type. |
| `ERR_AUTH_BEARER_REVOKE_CONTENDED` | `Revoke`: the record kept changing. |

A failing store (replay, revocation, cache) throws as the store does.
