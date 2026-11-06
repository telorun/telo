# Identity.DeclaredUsers

An `Auth.PasswordVerifier` over users written in the manifest.

```yaml
kind: Crypto.PasswordHash
metadata: { name: hasher }
---
kind: Identity.DeclaredUsers
metadata: { name: users }
hasher: !ref hasher
users:
  alice:
    passwordHash: !cel "secrets.aliceHash"
    roles: [admin]
    scopes: ["orders:read"]
    claims: { team: billing }
  bob:
    passwordHash: !cel "secrets.bobHash"
    subject: user-bob
```

| Field | Meaning |
| --- | --- |
| `hasher` | The `Crypto.PasswordHash` that verifies each password. It verifies a hash in any format it knows, so hashes made elsewhere work; its configured algorithm also sets the cost of the dummy check below. |
| `users` | The users by identifier, at least one. |
| `users.<id>.passwordHash` | The stored hash. |
| `users.<id>.subject` | The caller's stable id; the identifier when omitted. |
| `users.<id>.roles`, `scopes`, `claims` | Carried on the principal; empty when omitted. |

## Producing a `passwordHash`

Never write a password in a manifest. Hash it once with `Crypto.PasswordHash` and keep only the hash:

```yaml
kind: Telo.Sequence
metadata: { name: mint }
steps:
  - name: hashed
    invoke: !ref hasher
    inputs: { op: hash, password: !cel "variables.password" }
  - name: print
    invoke: { kind: Console.WriteLine }
    inputs: { output: !cel "steps.hashed.result.hash" }
```

Put the printed hash in the environment and bind it from `secrets:`, so it stays out of the repository and changes with the deployment:

```yaml
secrets:
  aliceHash: { env: ALICE_PASSWORD_HASH, type: string }
```

The entry then reads `passwordHash: !cel "secrets.aliceHash"`. A hash is not the password, but a leaked one can be attacked offline, so treat it as a secret. A `pepper` on the hasher is applied at hashing and at verification alike.

## The answer

A matching password answers `{ principal }`:

| Member | Value |
| --- | --- |
| `subject` | The entry's `subject`, else the identifier. |
| `kind` | `user`. |
| `roles`, `scopes`, `claims` | From the entry. |
| `amr` | `[pwd]`. |
| `via` | The resource's name. |

`issuer`, `org`, `acr`, `sessionId` and `authenticatedAt` are null, and `permissions` is empty.

Otherwise `{ refused: true, reason }` with `reason` `unknown` (no such identifier) or `mismatch` (wrong password). It never answers `disabled` or `throttled`; the second is `Protection.PasswordThrottle`'s.

## No user enumeration

Every attempt runs exactly one verification through the hasher. For an identifier that is not declared it is run against a dummy hash the resource makes once when it is created, with the hasher's own algorithm and parameters, so the work done, and the time taken, is that of a wrong password. The refusal differs only in `reason`, which a transport keeps from the client.

A hash whose parameters differ from the hasher's (an imported bcrypt hash at another cost) takes the time of its own parameters, so keep declared hashes at the hasher's settings if the difference matters.

A declared user is withdrawn by removing its entry. Nothing is stored or changed at run time, and a `rehash` verdict is not acted on.
