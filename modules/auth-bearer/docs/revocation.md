# Revocation

`revocation: { store }` names a `KvStore.Store` holding a denylist of `jti`s. A verifier refuses a token whose `jti` is listed (`revoked`) and, since a token without a `jti` could never be listed, refuses one lacking it as `claims`.

`AuthBearer.Revoke` writes the list: inputs `{ jti, until }`, output `{ revoked }`. The record lives until `until`, normally the token's `exp`, after which the token is expired anyway. A later revocation never shortens an earlier one, and `revoked: false` means `until` had already passed. The store is read on every request and never cached, so a revocation holds on every replica sharing it at the next request.

`Revoke` and the verifiers must be given the same store. A write that keeps losing to concurrent writers throws `ERR_AUTH_BEARER_REVOKE_CONTENDED`.
