# Identity

Where an application's users come from. `Identity.DeclaredUsers` holds users written in the manifest, each with a password hash, and checks an identifier and password against them. It is an `Auth.PasswordVerifier`, so `AuthBasic.Verifier` and any other consumer of one can use it.

## Kinds

| Kind | What it is |
| --- | --- |
| `Identity.DeclaredUsers` | An `Auth.PasswordVerifier` over `users`, keyed by identifier, checked through a `Crypto.PasswordHash` named by `hasher`. See [declared users](./docs/declared-users.md). |

The module imports `auth` and `crypto` and nothing about HTTP, so a directory-backed or database-backed checker can sit beside it and be used wherever a password checker is wanted.

Docs: [declared users](./docs/declared-users.md)
