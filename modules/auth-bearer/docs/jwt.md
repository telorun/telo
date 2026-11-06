# JWT access tokens

`AuthBearer.Jwt` verifies a JWT access token (RFC 9068). It reuses `Jose.Verify`'s checks: the algorithm comes from `algorithms`, never from the token, `none` is never accepted, and the claim checks run only after the signature verified.

| Key | Meaning |
| --- | --- |
| `keys` | Required. A `Jose.Keys`: a `Jose.RemoteKeySet` for another issuer, a `Jose.KeySet` for this application's own. |
| `issuer` | Required. The `iss` the token must carry; declared by `AuthBearer.AccessTokenVerifier` and published as the verifier's `issuer`. |
| `algorithms` | Required. Asymmetric algorithms only. |
| `types` | The accepted `typ` headers; `[at+jwt]` when omitted. `application/at+jwt` matches `at+jwt`, case-insensitively. |
| `clockTolerance`, `maxTokenAge` | As on `Jose.Verify`. |
| `requiredClaims` | Claims required besides `exp` and `sub`, which are always required. `jti` is added when `revocation` is configured. |

Order of checks: algorithm, key, signature, then issuer, audience, expiry, not-before and required claims, then `typ`; then [revocation](./revocation.md), [confirmation](./confirmation.md) and the [principal](./principal-mapping.md). The first failure decides the [reason](./refusals.md).

`audience` is evaluated per request over `resource`. With a transport that names no resource the binding is empty, and the token is refused as `audience`.

An unreachable `Jose.RemoteKeySet` throws `ERR_JOSE_REMOTE_KEYS_UNREACHABLE`, a local set whose store failed `ERR_JOSE_KEYSET_UNAVAILABLE`.
