# Opaque tokens and introspection

`AuthBearer.Introspection` asks the issuer's introspection endpoint (RFC 7662) about a token: a form-encoded `POST` with `token` and `token_type_hint=access_token`, answered with a JSON object.

| Key | Meaning |
| --- | --- |
| `endpoint` | Required. The endpoint's address. |
| `client` | An `Http.Credential` that authenticates this application at the endpoint (`Http.BasicAuth`, `Http.BearerToken`, `OAuthClient` credentials). It is consulted per call. |
| `issuer` | Required (declared by `AuthBearer.AccessTokenVerifier`). Published as the verifier's `issuer`. A response naming another `iss` is refused as `issuer`; a response without `iss` is accepted. |
| `cache` | A `Cache.Store` remembering active answers. |
| `maxAge` | The longest an answer is reused; 60s when omitted. |
| `timeout` | One call's time limit; 10s when omitted. |
| `clockTolerance` | Leeway for the response's `exp` and `nbf`. |

`active: false` is a refusal (`inactive`). An active answer needs a string `sub`, and is judged on every request, cached or not, for `iss`, `aud` (the response's `aud` must include the audience), `exp` and `nbf`, then [revocation](./revocation.md), [confirmation](./confirmation.md) and the [principal](./principal-mapping.md), with the response as `claims`.

## Caching

An entry lives no longer than the token's `exp` or `maxAge`, whichever is first, so a token revoked at the issuer can be accepted for up to `maxAge` more. The key is a digest of the endpoint and the token, never the token. A cache may evict, so freshness is all it guarantees: an evicted entry costs a new request. An inactive answer is never cached.

## Throwing

A connection failure, a timeout, a status other than 200 (including a rejected client) and an answer that is not a JSON object throw `ERR_AUTH_BEARER_INTROSPECTION_UNREACHABLE`: the token was never judged, so a transport answers 503, not 401.
