# Key management operations

`ApiKey.Issue`, `ApiKey.List`, `ApiKey.Revoke` and `ApiKey.Rotate` each name an `ApiKey.Store` in their `store` slot, so a source that can only look keys up (`ApiKey.DeclaredKeys`) is refused at `telo check`. They own every code and every rule; a store only stores (see [store contract](./store-contract.md)).

| Operation | Inputs | Output |
| --- | --- | --- |
| `Issue` | `owner`, `scopes`, `label?`, `expiresAt?` | `key` (shown once, sensitive), `id`, `owner`, `scopes`, `label`, `createdAt`, `expiresAt` |
| `List` | `owner`, `limit?` (1 to 200, default 50), `cursor?` | `keys` (`ApiKey.KeyRecord`, no secret or digest), `next?` |
| `Revoke` | `id`, `by?` | `id`, `revokedAt`, `revokedBy` |
| `Rotate` | `id`, `overlap?` (default `0s`), `expiresAt?` | as `Issue`, plus `previous: { id, expiresAt }` |

An **owner** is `{ type: user | service | organization, id }`.

- `Issue` refuses a scope outside the store's `scopes` (`ERR_API_KEY_SCOPE_UNKNOWN`), and, when the store states a `maxLifetime`, an `expiresAt` beyond it or no `expiresAt` (`ERR_API_KEY_LIFETIME_EXCEEDED`).
- `List` pages one owner's keys in id order, which follows creation time to the millisecond (keys issued within one millisecond list in no fixed order), revoked and expired ones included. The cursor is opaque and bound to the owner; one that is not a previous `next` is `ERR_API_KEY_CURSOR_INVALID`.
- `Revoke` sets `revokedAt` and `revokedBy` and is idempotent: repeating it keeps the first revocation. An unknown or malformed id is `ERR_API_KEY_NOT_FOUND`.
- `Rotate` issues a successor with the same owner, scopes and label (`rotatedFrom` records the old id) and caps the old key's expiry at the earlier of its own and now plus `overlap`, in one atomic store call. A revoked key is `ERR_API_KEY_REVOKED`; an unknown one `ERR_API_KEY_NOT_FOUND`. The `maxLifetime` check applies to the successor's `expiresAt`.

A store failure is `ERR_API_KEY_STORE_UNAVAILABLE`; an answer a store's interface rules out is `ERR_API_KEY_STORE_INCONSISTENT`.
