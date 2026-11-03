# Jose

JSON Web Tokens and keys for manifests: sign and verify JWTs, keep signing keys in a durable store with scheduled rotation, publish a JWKS, verify another issuer's tokens, and seal values (encrypted cookies, pending records) under a rotatable secret. Tokens, keys and sealed payloads are marked sensitive and kept out of trace payloads and the debug wire.

## Kinds

| Kind | What it is |
| --- | --- |
| `Jose.Keys` | Abstract: a source of verification keys. |
| `Jose.KeySet` | This application's signing keys — **managed** (`store`, `name`, `wrapKey`, `rotation`) or **static** (`keys:` JWKs from `secrets:`). `algorithm`: `ES256` (default), `RS256`, `EdDSA`, `HS256`. See [key sets](./docs/key-sets.md). |
| `Jose.RemoteKeySet` | Another issuer's keys, by `url` (a JWKS) or `issuer` (discovery), with `cacheTtl`, `cooldown` and `timeout`. |
| `Jose.Sign` | `{ claims?, subject?, audience?, expiresIn?, jwtId? }` → `{ token, kid, expiresAt }`. Configured with `keys`, `type` (`JWT` \| `at+jwt` \| `logout+jwt`), `issuer`, `audience`, `expiresIn` (15m), `notBefore`. `jwtId: auto` generates one. |
| `Jose.Verify` | `{ token, audience? }` → `{ valid: true, payload, header }` or `{ valid: false, reason }`. Configured with `keys`, `algorithms` (required), `issuer`, `audience`, `type`, `clockTolerance`, `maxTokenAge`, `requiredClaims`. See [verification](./docs/verification.md). |
| `Jose.Rotate` | `{ force? }` → `{ rotated, currentKid, retiredKids }`, on a managed set. |
| `Jose.PublicKeys` | `{}` → `{ keys }`, the public JWKS of the current and retiring keys. |
| `Jose.Encrypt` | `{ payload }` → `{ token }`: JWE compact, `dir` + `A256GCM`, under a key derived from `secret`. |
| `Jose.Decrypt` | `{ token }` → `{ valid: true, payload }` or `{ valid: false, reason: malformed \| unknownKey \| decryption }`; `previousSecrets` open tokens sealed before a secret rotation. |

```yaml
imports:
  Jose: oci://ghcr.io/telorun/jose@<version>
  Http: oci://ghcr.io/telorun/http-server@<version>
  Scheduler: oci://ghcr.io/telorun/scheduler@<version>
---
kind: Jose.KeySet
metadata: { name: signing }
store: !ref kv          # any KvStore.Store, declared elsewhere
name: api-tokens
wrapKey: !cel "secrets.keyWrap"
rotation: { every: 720h, retireAfter: 24h }
---
kind: Jose.Sign
metadata: { name: issue }
keys: !ref signing
issuer: https://api.example.com
audience: api
expiresIn: 15m
---
kind: Jose.Verify
metadata: { name: verify }
keys: !ref signing
algorithms: [ES256]
issuer: https://api.example.com
audience: api
---
kind: Http.Api
metadata: { name: wellKnown }
routes:
  - request: { path: /.well-known/jwks.json, method: GET }
    handler: { kind: Jose.PublicKeys, keys: !ref signing }
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
    catches:
      - status: 503
        content: { application/problem+json: {} }
---
kind: Scheduler.Cron
metadata: { name: rotateDaily }
cron: "0 3 * * *"
invoke: { kind: Jose.Rotate, keys: !ref signing }
```

## Errors

| Code | Raised when |
| --- | --- |
| `ERR_JOSE_KEYSET_UNAVAILABLE` | A managed set's store fails, a stored key will not unwrap because `wrapKey` changed, a static set is asked to rotate, or a static set holds no private key to sign with. |
| `ERR_JOSE_REMOTE_KEYS_UNREACHABLE` | A remote key set cannot be fetched (unreachable, an error status, not a JWKS, or discovery naming another issuer). |
| `ERR_JOSE_ALGORITHM_UNSUPPORTED` | At creation: a static key is not a JWK, is not of the configured algorithm's type, or does not import. |
| `ERR_JOSE_KEYSET_FORM` / `ERR_JOSE_REMOTE_KEYSET_SOURCE` | At creation: a key set names both or neither of `store` and `keys`, or a remote set both or neither of `url` and `issuer`. `telo check` reports both at the declaring module as `RESOURCE_RULE_VIOLATED`. |

A token refusal is never an error: `Jose.Verify` and `Jose.Decrypt` return it as `reason`.

## Code library

`exports.code` declares `@telorun/jose`: the key-set instance contract (`JoseKeys`, `JoseKeySet`, the `isJoseKeys` / `isJoseKeySet` guards and the error codes) and `verifyToken`, so a sibling module's controller holding a `Jose.Keys` through a reference slot verifies tokens with the same outcome reasons in-process. Import the module and name `@telorun/jose` from the controller.

## Sealed values

`Jose.Encrypt` and `Jose.Decrypt` derive their key from `secret` by HKDF, not a password KDF, so a `secret` (like a managed set's `wrapKey`) must be high-entropy: use 32 random bytes, for example from `Crypto.Random`. Sealed values carry no expiry: a stateless cookie stays valid until its secret leaves `previousSecrets`, so put a timestamp in the payload and check it when the value matters for a limited time. Tokens are interchangeable between any `Jose.Encrypt` and `Jose.Decrypt` resources sharing a secret.
