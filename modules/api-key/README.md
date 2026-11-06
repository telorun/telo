# ApiKey

API keys for authenticating the callers of an API: long-lived secrets handed to users, services and organizations. A key carries a checksum, so a mistyped one is refused before any lookup; only its SHA-256 digest is kept, compared in constant time and never cached, so a revocation holds on every replica at its next request.

## Kinds

| Kind | What it is |
| --- | --- |
| `ApiKey.KeySource` | Abstract provider that can look a key up. Every variant takes `prefix` and the closed `scopes` vocabulary. |
| `ApiKey.Store` | Abstract, extends `ApiKey.KeySource`. Adds issue, list, revoke, rotate and last-use recording, and an optional `maxLifetime`. See [store contract](./docs/store-contract.md). |
| `ApiKey.DeclaredKeys` | A `KeySource` whose keys are written in the manifest as digests. See [declared keys](./docs/declared-keys.md). |
| `ApiKey.Verifier` | Extends `Auth.Verifier`. Routes a presented key to one of its `sources` by prefix. See [verifier](./docs/verifier.md). |
| `ApiKey.Issue`, `ApiKey.List`, `ApiKey.Revoke`, `ApiKey.Rotate` | Key management against an `ApiKey.Store`. See [operations](./docs/operations.md). |
| `ApiKey.Generate` | Mints a key, its id and its digest without a store, for writing declared keys. |

The shapes `ApiKey.Owner` and `ApiKey.KeyRecord` are exported for contracts. A backend that stores keys in a database is another module extending `ApiKey.Store`; this module declares none.

```yaml
imports:
  ApiKey: oci://ghcr.io/telorun/api-key@<version>
  Http: oci://ghcr.io/telorun/http-server@<version>
---
kind: ApiKey.DeclaredKeys
metadata: { name: serviceKeys }
prefix: svc
scopes: [orders:read, orders:write]
keys:
  - id: apk_01tRy6czI6jAOLpZvq3hw1
    digest: !cel "secrets.billingDigest"
    owner: { type: service, id: billing }
    scopes: [orders:read]
---
kind: ApiKey.Verifier
metadata: { name: apiKeys }
sources: [!ref serviceKeys]
```

Mount it with `authentication: { verifiers: [{ verifier: !ref apiKeys, from: { kind: Http.FromHeader, header: x-api-key } }] }`. The handler reads `request.principal`.

Docs: [key format](./docs/key-format.md) · [verifier](./docs/verifier.md) · [declared keys](./docs/declared-keys.md) · [operations](./docs/operations.md) · [store contract](./docs/store-contract.md)
