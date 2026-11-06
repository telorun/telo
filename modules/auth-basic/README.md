# AuthBasic

HTTP Basic authentication for an API: the user identifier and password a request carries are handed to a password checker, and the answer is the authenticated caller or a refusal that challenges the client to send credentials again.

## Kinds

| Kind | What it is |
| --- | --- |
| `AuthBasic.Verifier` | Extends `Auth.Verifier`. Takes `passwords` (any `Auth.PasswordVerifier`) and `realm`, and reads `basic` presentations only. See [verifier](./docs/verifier.md). |

The module checks no password itself. Pair it with `Identity.DeclaredUsers` for users written in the manifest, wrap that in `Protection.PasswordThrottle` to bound guessing, or supply any other `Auth.PasswordVerifier`.

```yaml
imports:
  AuthBasic: oci://ghcr.io/telorun/auth-basic@<version>
  Identity: oci://ghcr.io/telorun/identity@<version>
  Crypto: oci://ghcr.io/telorun/crypto@<version>
  Http: oci://ghcr.io/telorun/http-server@<version>
---
kind: Crypto.PasswordHash
metadata: { name: hasher }
---
kind: Identity.DeclaredUsers
metadata: { name: users }
hasher: !ref hasher
users:
  alice: { passwordHash: !cel "secrets.aliceHash", roles: [admin] }
---
kind: AuthBasic.Verifier
metadata: { name: basic }
passwords: !ref users
realm: Orders
```

Mount it with `authentication: { verifiers: [{ verifier: !ref basic, from: { kind: Http.FromBasic } }] }`. The handler reads `request.principal`.

Docs: [verifier](./docs/verifier.md)
