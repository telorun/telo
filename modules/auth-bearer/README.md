# AuthBearer

Access-token verification for resource servers: the OAuth 2.0 tokens a client presents to an API. Both verifiers extend `Auth.Verifier`, accept `token` presentations, and answer with a principal or a refusal carrying the challenge to send back.

## Kinds

| Kind | What it is |
| --- | --- |
| `AuthBearer.AccessTokenVerifier` | Abstract, extends `Auth.Verifier`. Declares the keys both verifiers share: `audience`, `confirmation`, `revocation`, `principal`. |
| `AuthBearer.Jwt` | Verifies a JWT access token (RFC 9068) against a `Jose.Keys` (`Jose.KeySet`, `Jose.RemoteKeySet`). See [JWT](./docs/jwt.md). |
| `AuthBearer.Introspection` | Verifies an opaque token by asking the issuer's endpoint (RFC 7662). See [introspection](./docs/introspection.md). |
| `AuthBearer.Revoke` | Invocable `{ jti, until }` → `{ revoked }`: adds a `jti` to the denylist. See [revocation](./docs/revocation.md). |

```yaml
imports:
  AuthBearer: oci://ghcr.io/telorun/auth-bearer@<version>
  Jose: oci://ghcr.io/telorun/jose@<version>
---
kind: AuthBearer.Jwt
metadata: { name: tokens }
keys: { kind: Jose.RemoteKeySet, issuer: https://login.example.com/ }
issuer: https://login.example.com/
algorithms: [RS256]
audience: !cel "[resource]"
```

## Shared settings

| Key | Meaning |
| --- | --- |
| `audience` | Required. A string, a list, or an expression over `resource` (`!cel "[resource]"`) binding the token to the protected resource the transport names (RFC 8707). |
| `confirmation` | Sender-constrained tokens: `dpop` (`replay` store, `algorithms`, `maxProofAge`, `required`) and `certificateBound`. See [confirmation](./docs/confirmation.md). |
| `revocation` | `{ store }`: a `KvStore.Store` of revoked `jti`s. |
| `principal` | Expressions over `claims` for `kind`, `scopes`, `roles`, `permissions`, `org`. See [principal mapping](./docs/principal-mapping.md). |

A verifier's reading publishes `issuer`, as configured, which a transport turns into protected-resource metadata (RFC 9728). It also publishes `challenges`: `Bearer`, plus `DPoP` with `algs` (the proof algorithms `confirmation.dpop` accepts) when DPoP proofs are verified. A transport sends these to a request that presented no token.

## Refusing and throwing

A token that fails a check is an answer: `{ refused: true, reason, challenge }`, with the `reason` from a closed list and a `Bearer` or `DPoP` challenge carrying `error="invalid_token"`. A key source or introspection endpoint that cannot be reached throws, so a transport can answer 503 instead of 401. See [refusals](./docs/refusals.md).

Docs: [JWT](./docs/jwt.md) · [introspection](./docs/introspection.md) · [confirmation (DPoP and certificate binding)](./docs/confirmation.md) · [revocation](./docs/revocation.md) · [principal mapping](./docs/principal-mapping.md) · [refusals](./docs/refusals.md)
