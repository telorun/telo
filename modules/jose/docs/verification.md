# Verification

`Jose.Verify` checks a compact JWS JWT against a `Jose.Keys` (a local `Jose.KeySet` or a `Jose.RemoteKeySet`) and returns an outcome:

- `{ valid: true, payload, header }` — the claims and the protected header;
- `{ valid: false, reason }` — why the token was refused.

A refusal is a returned value, not an error, following the precedent of `OAuthClient.Callback`: an HTTP authenticator renders it as 401 and a sequence branches on it with `!cel "steps.verify.result.valid"`. Only a key source that cannot be reached throws — `ERR_JOSE_REMOTE_KEYS_UNREACHABLE` for a remote set, `ERR_JOSE_KEYSET_UNAVAILABLE` for a managed set whose store failed — because then the token was never judged, and answering 401 would blame the caller for an outage.

## Why `algorithms` is required

The token's header names the algorithm it claims to be signed with. Taking it from there is the classic JWT flaw: `alg: none` turns off the signature, and `HS256` over an RSA or EC set makes a verifier that uses the public key as an HMAC secret accept tokens anyone can forge. So `algorithms` lists the only algorithms this verifier accepts, and is required; `none` is not in the vocabulary at all. A key is chosen only if its type matches the token's algorithm (`EC` P-256 for ES256, `RSA` for RS/PS, `OKP` Ed25519 for EdDSA, `oct` for HS), so even with `HS256` listed beside `ES256`, an HS256 token against an EC set finds no key.

## Order of checks and reasons

| Reason | When |
| --- | --- |
| `malformed` | Not three dot-separated parts, an unreadable header or payload, a payload that is not a JSON object, or an unsupported critical header. |
| `algorithm` | The header's `alg` is not in `algorithms` (including `none`). |
| `unknownKey` | No key in the set matches the header's `kid` and is of the algorithm's type. |
| `signature` | The signature does not verify under any matching key. |
| `type` | `type` is configured and the `typ` header differs (`at+jwt` matches `application/at+jwt`). |
| `claims` | A `requiredClaims` member is missing, a token without `iat` meets `maxTokenAge`, `iat` lies in the future while `maxTokenAge` is set, or `iat` / `nbf` / `exp` is not a number. |
| `issuer` | `issuer` is configured and `iss` is absent or differs. |
| `audience` | An audience is configured or given and `aud` is absent or does not include it. |
| `notBefore` | `nbf` is still in the future. |
| `expired` | `exp` has passed, or `iat` is older than `maxTokenAge`. |

The checks run in that order, and the claim checks only after the signature has verified, so nothing about an unauthenticated token's claims is reported. `clockTolerance` widens every time comparison by the given duration.

`exp` is not required: a token without one never expires unless `requiredClaims` lists `exp`.

## Audience

`audience` on the resource is what every call checks; a call's own `audience` input replaces it, for one verifier serving several audiences. With neither, `aud` is not checked — set one whenever tokens of several services share an issuer.

## In-process verification

A sibling module's controller holding a `Jose.Keys` through a reference slot calls `verifyToken(keys, token, policy, signal)` from `@telorun/jose`, which returns the same outcomes for the same reasons.
