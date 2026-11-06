# ApiKey.Verifier

Extends `Auth.Verifier`. It takes `sources`, a list of `ApiKey.KeySource`, and `lastUsedResolution` (default `1h`).

## Reading a key

1. It accepts only `token` presentations, from any credential source (`Http.FromHeader`, `Http.FromQuery`, `Http.FromAuthorization`, with the scheme of the author's choice). Any other variant is refused as `malformed`.
2. It checks the key's shape and checksum. A failure is `malformed`, with no source asked.
3. It picks the source whose prefix the key carries; a key with an unknown prefix is `malformed`.
4. It asks that source for the key's id, compares the digest in constant time, then judges revocation and expiry.

Nothing is cached: the lookup is one read on a unique index, and a per-replica cache would let replicas honour a revocation at different times.

## Answers

A refusal is returned, never thrown: `{ refused: true, reason, challenge: null }` with `reason` one of:

| Reason | When |
| --- | --- |
| `malformed` | Not a token presentation, wrong shape or checksum, or a prefix no source has. |
| `unknown` | No such key, or the secret does not match the stored digest. |
| `revoked` | The key was revoked. |
| `expired` | The key's `expiresAt` has passed. |

The reason is for logs and operators only. The verifier publishes `challenges: []`: the scheme a caller is asked for comes from the credential source (`Http.FromHeader { scheme: ApiKey }`). It declares no `issuer`, which `Auth.Verifier` reserves for an authorization server whose tokens it accepts.

A source that fails (a database that cannot be reached) is a thrown `ERR_API_KEY_STORE_UNAVAILABLE`, which the HTTP server answers as 503.

## The principal

| Member | Value |
| --- | --- |
| `subject` | The owner's id. |
| `kind` | `user` for a user-owned key, otherwise `service`. |
| `org` | The owner's id for an organization-owned key, otherwise null. |
| `scopes` | The key's scopes. |
| `claims.apiKeyId` | The public id; it is the bucket to rate-limit by. |
| `via` | The verifier's name. |

`issuer`, `sessionId`, `acr` and `authenticatedAt` are null, and `roles`, `permissions` and `amr` empty.

## Last use

For a source that records it (an `ApiKey.Store`), a successful request calls the store's `touch`, one conditional write per key per `lastUsedResolution` across all replicas; `lastUsedAt` is therefore accurate to within that interval. The verifier skips the call while the last use it just read is still fresh. `ApiKey.DeclaredKeys` records nothing.

## Several sources

Each source has its own prefix, so one verifier can accept keys from the manifest and from a database. Two sources of one verifier with the same prefix are `API_KEY_PREFIX_DUPLICATE` at `telo check` (reported as `RESOURCE_RULE_VIOLATED` with that rule) and `ERR_API_KEY_PREFIX_DUPLICATE` at start. One verifier routes across sources because the HTTP seam never falls through to the next verifier on a refused credential.
