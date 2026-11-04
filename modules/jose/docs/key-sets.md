# Key sets

A `Jose.KeySet` holds the keys this application signs tokens with. It takes one of two forms, chosen by which field it declares: `store` (managed) or `keys` (static). Declaring both or neither is refused by `telo check` and at creation.

## Managed sets

```yaml
kind: Jose.KeySet
metadata: { name: signing }
store: !ref kv              # any KvStore.Store
name: api-tokens            # the set's identity in the store
wrapKey: !cel "secrets.keyWrap"
algorithm: ES256            # ES256 | RS256 | EdDSA | HS256
rotation: { every: 720h, retireAfter: 24h }
cacheTtl: 30s
```

`store`, `name`, `wrapKey` and `rotation` go together; none of them may appear on a static set.

### The record

The whole set is **one record** in the store, at the key `jose/keyset/<name>`. It holds the current key id and every key still in the set, each with:

- its `kid` and `alg`;
- its public JWK (none for HS256);
- its private JWK, wrapped (below);
- its creation time and, once replaced, its retirement time.

`name` is the set's identity, never derived from the resource name: two resources over one store with one `name` are two replicas of one set, and renaming a resource keeps its keys. The record is written with a century-long TTL, since a `KvStore.Store` requires one, refreshed on every write.

The first key is generated on first use — the first `Jose.Sign`, `Jose.Verify`, `Jose.PublicKeys` or `Jose.Rotate` — and written with `putIfAbsent`, so replicas starting together adopt one first key.

### Wrapping

A key/value store is shared infrastructure, so private keys never reach it in the clear. Each private JWK is sealed as a JWE (`dir`, `A256GCM`) under a 256-bit key derived from `wrapKey` by HKDF-SHA-256 (through `@telorun/crypto`), with the set's `name` in the HKDF info so a wrapped key is bound to its set. The wrap header carries a digest prefix of the derived key: a set whose `wrapKey` changed reports `ERR_JOSE_KEYSET_UNAVAILABLE` naming the cause, rather than a decryption failure. `wrapKey` goes through HKDF, not a password KDF, so it must be high-entropy: use 32 random bytes, for example from `Crypto.Random`. Losing `wrapKey` loses the set; keep it with your other secrets.

### Rotation

`Jose.Rotate` makes a new key current and stamps the replaced key with a retirement time `rotation.retireAfter` from now. A retired key stops verifying at that time (every reader compares the time, so the cutoff does not wait for a write) and the next rotation removes it from the record, reporting its kid in `retiredKids`.

- Without `rotation.every`, every `Jose.Rotate` makes a new key.
- With it, a rotation without `force: true` makes one only once the current key is at least that old — so a schedule firing on every replica, or more often than `every`, rotates once. A changed `algorithm` also makes a rotation due.
- Set `retireAfter` above the longest token lifetime plus `cacheTtl`, or tokens signed just before a rotation stop verifying before they expire.

Every write is a `compareAndSet` against the version the writer read. A writer that loses re-reads; if the current key changed meanwhile, another writer rotated, and the loser adopts that rotation (`rotated: false`) instead of making a second key. Two replicas rotating at once therefore leave one current key and one new key.

Rotation is a dispatch, so the schedule is the consumer's:

```yaml
kind: Scheduler.Cron
metadata: { name: rotateNightly }
cron: "0 3 * * *"
invoke: { kind: Jose.Rotate, keys: !ref signing }
```

### Reading the record

Signing, verification and `Jose.PublicKeys` reuse the record they last read for `cacheTtl` (30s by default). A replica therefore learns of another replica's rotation within `cacheTtl`; a token naming a kid the held copy lacks re-reads the record at once (at most once a second), so a token signed by a freshly rotated key verifies everywhere immediately. A store failure is `ERR_JOSE_KEYSET_UNAVAILABLE` with the store's error as its cause.

## Static sets

```yaml
kind: Jose.KeySet
metadata: { name: signing }
algorithm: RS256
keys: !cel "secrets.signingKeys"   # a secret declared `type: array`, holding JWKs
```

For a team whose keys come from outside. Every key must be a JWK of the configured algorithm's type (`EC` P-256 for ES256, `RSA` for RS256, `OKP` Ed25519 for EdDSA, `oct` for HS256), with no `alg` or `use` saying otherwise, or creation fails with `ERR_JOSE_ALGORITHM_UNSUPPORTED`. The first key holding private material signs; every key verifies, so a key being phased out stays in the list after its successor. A key without `kid` gets its RFC 7638 thumbprint. A static set holding only public keys verifies and cannot sign (`ERR_JOSE_KEYSET_UNAVAILABLE` from `Jose.Sign`). A static set cannot rotate: `Jose.Rotate` refuses with `ERR_JOSE_KEYSET_UNAVAILABLE`.

## Publication

`Jose.PublicKeys` returns `{ keys }`, the public JWKs of the current key and every key still in its grace period, each with `kid`, `alg` and `use: sig`. An HS256 set publishes nothing — its keys are secrets. Mount it at `/.well-known/jwks.json`:

```yaml
routes:
  - request: { path: /.well-known/jwks.json, method: GET }
    handler: { kind: Jose.PublicKeys, keys: !ref signing }
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
    catches:
      - status: 503
        content: { application/problem+json: {} }
```

It is an invocable rather than the provider's value because a provider's value is taken once, at initialization, and keys rotate afterwards.

## Remote key sets

`Jose.RemoteKeySet` verifies tokens another issuer signed: `url` names its JWKS, or `issuer` finds it through the issuer's OpenID Connect metadata (`<issuer>/.well-known/openid-configuration`, then the RFC 8414 location), whose `issuer` must equal the configured one exactly. Fetched keys are used for `cacheTtl` (10m); a token naming a kid the cache lacks refetches early, at most once per `cooldown` (30s). Each fetch is bounded by `timeout` (10s) and goes through the platform `fetch`. A key set it cannot fetch makes `Jose.Verify` throw `ERR_JOSE_REMOTE_KEYS_UNREACHABLE` rather than refuse the token, since the token was never judged. Symmetric (`oct`) keys in a fetched JWKS are ignored.
