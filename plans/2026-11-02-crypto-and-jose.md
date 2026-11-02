# Keys: `crypto` and `jose`

The keys track of phase 0 in `plans/identity-and-access.md`. Two new bundled modules: `crypto`
(random values, digests, MACs, password hashing, constant-time comparison, key derivation)
and `jose` (JWT signing and verification, key sets with rotation, JWKS, sealed values). Each
is a kind library for manifests and a code library (`exports.code:`) for sibling controllers.
`jose` uses `@telorun/crypto` for key derivation. Neither depends on the transport plan.

## Problem

- **Crypto has no shared home.** Random tokens, digests and constant-time comparison exist only
  as private code inside controllers: `oauth-client`'s PKCE, the key/value stores' ids, and
  `lease`'s claims. A manifest cannot hash a password, and the next module that needs to would
  grow another private copy.
- **Nothing does JOSE.** Nothing signs or verifies a JWT, publishes a JWKS, rotates a signing
  key or seals a value. `oauth-client` stores an ID token "verbatim and otherwise untouched",
  because nothing can check it.

## 1. `crypto` (`Crypto`)

**Before.** Private copies in several controllers, and nothing reachable from a manifest.

**After.** The module carries categories `[Security]`.

- Random bytes, digests, HMAC, scrypt, PBKDF2, HKDF and constant-time comparison use Node's own
  primitives.
- Argon2id and bcrypt come from `hash-wasm`, inlined: it is pure JS with the WebAssembly
  embedded, so it bundles like everything else. The `argon2` package is a native addon that
  esbuild cannot inline.
- A `pkg:cargo` candidate can join the controller list later without changing the surface.

Every kind is one operation and a `Telo.Invocable`. Text inputs are UTF-8 strings, and byte
inputs are accepted as `Telo.Bytes`. Every value marked sensitive below is `x-telo-sensitive`.

| Kind | Inputs → outputs |
| --- | --- |
| `Crypto.Random` | `{ bytes (default 32), encoding: hex \| base64url (default) \| base64 }` → `{ value }`. The value is sensitive: it becomes the next session id or API key. |
| `Crypto.Digest` | `{ algorithm: sha256 (default) \| sha384 \| sha512, input, encoding (default hex) }` → `{ value }` |
| `Crypto.Hmac` | `{ op: sign \| verify, algorithm, key (sensitive), input, encoding (default hex), expected? }` → `{ value }` for `sign`, `{ valid }` for `verify`. Verification decodes `expected` and compares in constant time. An `expected` that will not decode is `valid: false`. |
| `Crypto.PasswordHash` | `{ op: hash \| verify, password (sensitive), hash? (sensitive) }` → `{ hash }` for `hash`, `{ valid, rehash }` for `verify`. Details below. |
| `Crypto.Compare` | `{ a, b }` (both sensitive) → `{ equal }`, in constant time. CEL's `==` is not constant-time. |
| `Crypto.DeriveKey` | `{ secret (sensitive), salt, info, length (default 32), hash (default sha256), encoding (default base64url) }` → `{ key }` (sensitive), by HKDF. |

**`Crypto.PasswordHash` details.**

- The resource is configured with `algorithm: argon2id (default) | bcrypt | scrypt | pbkdf2`.
  Each algorithm's parameters default to the OWASP recommendations:

  | Algorithm | Default parameters |
  | --- | --- |
  | argon2id | `memoryKiB: 19456`, `iterations: 2`, `parallelism: 1` |
  | bcrypt | `cost: 12` |
  | scrypt | `cost: 131072`, `blockSize: 8`, `parallelization: 1` |
  | pbkdf2 | `iterations: 600000` over SHA-256 |

- **Pepper.** An optional `pepper` from `secrets:` is applied as an HMAC-SHA256 of the password
  before hashing. Changing it invalidates every stored hash, which the docs state.
- **Verification across formats.** `verify` accepts every PHC or MCF encoding the module knows,
  whatever the configuration, so imported hashes verify.
- **Migration.** `rehash: true` means the stored hash is weaker than the configured one: a
  different algorithm or weaker parameters. The caller re-hashes after a successful login,
  which is the standard migration path.
- **bcrypt length limit.** bcrypt refuses a password over 72 bytes with
  `ERR_PASSWORD_TOO_LONG` instead of silently truncating it.

**Code library.** `exports.code: @telorun/crypto` carries the same operations as functions, so
`api-key`, `session`, `identity` and `jose` call them in-process instead of dispatching.

**Errors.**

- `ERR_CRYPTO_UNSUPPORTED_HASH`: `verify` was given an encoding the module does not know.
- `ERR_PASSWORD_TOO_LONG`.

**Verify.**

- `modules/crypto/tests/password-hash.yaml`:
  - Hash then verify, for each algorithm.
  - A wrong password returns `valid: false`.
  - A literal imported bcrypt hash verifies with `rehash: true` under the argon2id default.
  - The 72-byte refusal.
  - A peppered hash fails to verify without its pepper.
- `modules/crypto/tests/hmac.yaml`: a known RFC 4231 vector signs to its exact value, and
  verify accepts it and rejects a one-character change.
- `modules/crypto/tests/random-digest.yaml`: length and encoding of `Random`, and known
  SHA-256/384/512 vectors for `Digest`.
- `modules/crypto/tests/compare.yaml`: equal and unequal inputs, including different lengths.
- `modules/crypto/tests/derive-key.yaml`: an RFC 5869 vector.

## 2. `jose` (`Jose`)

**Before.** Nothing signs, verifies, encrypts or publishes keys.

**After.** The module carries categories `[Security]`.

- The `jose` package (6.x, already in the lockfile; pure JS over WebCrypto) is inlined.
- `exports.code: @telorun/jose` carries the key-set instance contract that a phase-1 bearer
  verifier and a phase-5 authorization server call in-process.

**Key sources:**

- **`Jose.Keys`** is an abstract provider: something that yields verification keys.
- **`Jose.KeySet`** (extends `Keys`) is the local signing key set, in one of two forms.
  - **Managed:**
    - It is configured with `store: !ref KvStore.Store`, `wrapKey` (from `secrets:`),
      `algorithm` (`ES256` default, or `RS256`, `EdDSA`, `HS256`) and
      `rotation: { retireAfter }`.
    - The set is one record in the store, written with `compareAndSet`, so two replicas
      rotating at once converge and the loser re-reads. The record holds:
      - the current key id;
      - every key, with its wrapped private JWK, public JWK, creation time and retirement time.
    - Private material is wrapped under a key derived from `wrapKey` (HKDF through
      `@telorun/crypto`) before it is stored, because a key/value store is shared
      infrastructure.
    - The first key is generated on first use.
  - **Static:** `keys:` (JWKs from `secrets:`), with no store and no rotation. This is for a
    team whose keys come from outside.
  - An `HS256` set publishes no public keys.
- **`Jose.RemoteKeySet`** (extends `Keys`) fetches someone else's keys.
  - It is configured with `url` (a JWKS) or `issuer` (discovery leads to `jwks_uri`),
    `cacheTtl` and `timeout`.
  - It refetches on an unknown `kid`, under a cooldown.
  - Fetches go through the platform `fetch`, as `oauth-client` does.

**Signing and verifying:**

- **`Jose.Sign`** references `keys: !ref Jose.KeySet` and is configured with `type` (`JWT`
  default, `at+jwt`, `logout+jwt`), `issuer`, `audience`, `expiresIn` and `notBefore`.
  - Inputs: `{ claims, subject?, audience?, expiresIn?, jwtId? }`. `jwtId: auto` generates one.
  - Outputs: `{ token (sensitive), kid, expiresAt }`.
- **`Jose.Verify`** references `keys: !ref Jose.Keys`.
  - It is configured with `algorithms`, which is required: no algorithm is ever taken from the
    token. It also takes `issuer`, `audience`, `type` (matched against the `typ` header),
    `clockTolerance`, `maxTokenAge` and `requiredClaims`.
  - Inputs: `{ token (sensitive), audience? }`.
  - Outputs: `{ valid: true, payload, header }`, or `{ valid: false, reason }` where `reason`
    is one of `malformed`, `algorithm`, `unknownKey`, `signature`, `expired`, `notBefore`,
    `issuer`, `audience`, `type` or `claims`.
  - A refusal is a returned outcome, following the `Callback` precedent: an authenticator
    renders it as 401, and a sequence branches on it.
  - Only an unreachable remote key set throws, with `ERR_JOSE_REMOTE_KEYS_UNREACHABLE`.

**Sealed values:**

- **`Jose.Encrypt` / `Jose.Decrypt`** use JWE compact with `dir` and `A256GCM`.
  - The key is derived by HKDF from `secret` (from `secrets:`).
  - An optional `previousSecrets` list is used for decryption only, so the secret can be rotated
    without logging every session out. The header's `kid` is a digest prefix of the derived key,
    so decryption picks the matching secret.
  - `Encrypt`: `{ payload (sensitive) }` → `{ token (sensitive) }`.
  - `Decrypt`: back to `{ valid: true, payload }`, or `{ valid: false, reason: malformed |
    unknownKey | decryption }`.
  - These are what a stateless encrypted cookie and a sealed pending record are made of.
  - Key sets are signing keys and play no part in encryption.

**Rotation and publication:**

- **`Jose.Rotate`** references `keys: !ref Jose.KeySet`.
  - Inputs: `{ force? }`. Outputs: `{ rotated, currentKid, retiredKids }`.
  - A new key becomes current. The previous key keeps verifying until `retireAfter` elapses,
    then leaves the set.
  - Rotation is a dispatch, so the schedule belongs to the consumer: `Scheduler.Cron` invokes
    it.
  - A static set refuses with `ERR_JOSE_KEYSET_UNAVAILABLE`.
- **`Jose.PublicKeys`** references `keys: !ref Jose.Keys`.
  - Inputs: `{}`. Outputs: `{ keys }`, the public JWKS of the current and retiring keys.
  - An `Http.Api` route renders this at `/.well-known/jwks.json`.
  - It is an invocable rather than the provider's value, because a provider's value is taken
    once at init and keys rotate afterwards.

**Errors.**

| Code | Raised when |
| --- | --- |
| `ERR_JOSE_KEYSET_UNAVAILABLE` | The store is unreachable, a wrapped key will not unwrap because `wrapKey` changed, or a static set is asked to rotate. |
| `ERR_JOSE_REMOTE_KEYS_UNREACHABLE` | A remote key set cannot be fetched. |
| `ERR_JOSE_ALGORITHM_UNSUPPORTED` | A configured algorithm is outside the list, or a static key cannot serve the configured algorithm. |

**Verify.**

- `modules/jose/tests/sign-verify.yaml`: static keys, for each algorithm.
- `modules/jose/tests/verify-outcomes.yaml` asserts every reason by name. The cases include an
  expired token, a wrong audience, `alg: none`, and an HS256 token against an asymmetric key.
- `modules/jose/tests/rotate.yaml` runs a managed set over `KvStoreMemory.Store`:
  1. Sign under the first key, rotate, and sign under the second; both tokens verify.
  2. Once the first key is retired, its token reports `unknownKey`.
  3. Two concurrent rotations leave one current key.
- `modules/jose/tests/encrypt-decrypt.yaml`:
  - A round trip.
  - A tampered token is refused.
  - A token sealed under a previous secret decrypts once that secret is in `previousSecrets`,
    and is refused without it.
- `modules/jose/tests/remote-keyset.yaml`:
  - An `Http.Server` in `with:` serves `Jose.PublicKeys`, and a `Jose.RemoteKeySet` pointed at
    it verifies a token.
  - It refetches on a rotated `kid`.
  - Pointed at a closed port, it throws `ERR_JOSE_REMOTE_KEYS_UNREACHABLE`.

## Cross-cutting

- **Packaging.** Each module has:
  - `modules/<name>/telo.yaml` with `license: MIT`, plus a `LICENSE` file;
  - a private `nodejs/` build package (`@telorun/<name>-build`);
  - `tests/*.yaml`, a `README.md` and `docs/`;
  - one `pkg:telo/local/js` bundle with one `#fragment` per kind.

  `modules/README.md` gains a `Security` section listing both modules.
- **Releases.** Both modules are new and take `telo release add` fragments only.
- **Floors.** Both declare `telo: ">=0.84.0"`, the release that first honoured `x-telo-sensitive`
  on contract properties, and raise it to whatever newer surface they end up using.
  - Their contracts mark tokens, passwords and keys. An older runtime does not reject the
    annotation; it ignores it and puts the value on the debug wire.
  - The execution check therefore shows no rejection. The floor guards against the silent leak,
    not against a syntax error.
- **Docs.**
  - `crypto`: `docs/password-hashing.md` covers parameters, pepper, rehash-on-login and imported
    hashes.
  - `jose`: `docs/key-sets.md` covers the managed record, wrapping, rotation through
    `Scheduler.Cron` and static keys, and `docs/verification.md` covers the outcome reasons and
    why `algorithms` is required.
- **Authoring agent.** The primer gains password hashing and constant-time comparison, signing
  and verifying a JWT, serving a JWKS, and scheduled rotation.
- **Benefits ledger.** Under Standard library → Security:
  - Password hashing with transparent upgrade on login.
  - JWT signing and verification with rotating keys and a published JWKS.
- **Out of scope.** `oauth-client` keeps its private PKCE code. Moving it onto
  `@telorun/crypto` is an optional tidy-up, not a dependency.
