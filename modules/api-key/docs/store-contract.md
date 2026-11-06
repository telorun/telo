# Store contract

The interface is exported as `@telorun/api-key` (an `exports.code` specifier of this module). A store is **recognised by its methods**, never by its class or by having imported this module. It stores and answers **outcomes**; the operations and the verifier own every error code, the key format, the digest, id and secret minting, scope and lifetime checks and the list cursor envelope.

A kind providing a store `extends: ApiKey.Store`, takes its `prefix`, `scopes` and `maxLifetime` from the abstract, and its instance implements the methods below. `keySourceSettingsOf(resource, describe)` reads the abstract's configuration once for `settings()`. A source that only looks keys up extends `ApiKey.KeySource` and implements `settings` and `lookup`.

Every method takes the calling invocation's context last, for cancellation. Keys are addressed by their **UUID**; `publicIdOf` and `uuidOfPublicId` convert. A failure of the storage is thrown as it arrives.

## KeySource

| Method | Answers |
| --- | --- |
| `settings()` | `{ prefix, scopes, maxLifetimeMs }` (`maxLifetimeMs` null when none). |
| `lookup(id)` | `{ outcome: "found", key }` or `{ outcome: "absent" }`. Revoked and expired keys are found. |
| `touch?(id, resolution)` | Optional on a source. `touched` after writing, `fresh` when the last use is within `resolution`, `absent`. One conditional write against the store's own clock, so replicas write at most once per interval. |

## Store (adds)

| Method | Answers |
| --- | --- |
| `touch(id, resolution)` | Required. |
| `issue({ id, digest, owner, scopes, label, expiresAt })` | `{ outcome: "issued", key }`. |
| `list({ owner, limit, after? })` | `{ outcome: "page", keys, next? }` in UUID order, `next` only when more exist, or `{ outcome: "cursorInvalid" }` for an `after` it cannot read as its own. |
| `revoke(id, { by })` | `revoked` (with the key), `alreadyRevoked` (the key as it stands; the first revocation is kept) or `absent`. |
| `rotate({ id, successor: { id, digest, expiresAt }, overlap })` | `rotated` with `predecessor` and `successor`, `revoked` (nothing changed) or `absent`. Atomic: the successor takes the old key's owner, scopes and label and records `rotatedFrom`; the old `expiresAt` becomes the earlier of its own and the store's now plus `overlap`. |

A `StoredKey` is `{ id, digest, owner, scopes, label, createdAt, expiresAt, revokedAt, revokedBy, lastUsedAt, rotatedFrom }`, instants being timestamp values and `rotatedFrom` a UUID. Every instant a store writes is its own clock's.

A store never caches a lookup, and must not honour a revocation at different times on different replicas.

A store may **forget** a revoked or expired key once it has been over for a retention window of its own. A forgotten key answers `absent` from every method — `lookup`, `touch`, `revoke` and `rotate` — and is left out of `list`, and it does so at the same moment on every replica, so the store judges the window itself (on its own clock) rather than leaving it to a background cleanup. Until then a revoked or expired key is found, as above.
