# OneTime

Single-use links and typed codes kept in a `KvStore.Store`: a password-reset or email-verification link, a magic link, an invitation, a one-time sign-in code. A token works once, expires, can be bound to the browser that asked for it, and a code stops redeeming after a few wrong guesses. A set holds at most one live token per subject, and issuing again is allowed only after a waiting period.

## Kinds

| Kind | What it is |
| --- | --- |
| `OneTime.Tokens` | The abstract token set: `store`, `name`, `expiresIn`, `reissueAfter`, `dataType`. See [token sets](./docs/token-sets.md). |
| `OneTime.Links` | A set of URL tokens (`bytes`, 32 by default, at least 16; base64url). |
| `OneTime.Codes` | A set of typed codes (`digits`, 6 to 10, default 6; `maxAttempts`, default 5). |
| `OneTime.Issue` | `{ subject, data?, holder? }` → `{ issued: true, token, expiresAt }` or `{ issued: false, retryAfter }`. |
| `OneTime.RedeemLink` | `{ token, holder? }` → `{ redeemed: true, subject, data }` or `{ redeemed: false, reason }`. |
| `OneTime.RedeemCode` | `{ subject, token, holder? }`, answering as `RedeemLink` does. |
| `OneTime.Revoke` | `{ subject }` → `{ revoked }`. |

Every operation names its set through a `tokens` slot: `Issue` and `Revoke` take either kind, `RedeemLink` only links and `RedeemCode` only codes, so a wrong pairing is refused by `telo check`. A refused issue or redemption is an outcome, never a throw; `ERR_ONE_TIME_CONTENDED` and `ERR_ONE_TIME_STORE_UNAVAILABLE` are the only failures.

```yaml
imports:
  OneTime: oci://ghcr.io/telorun/one-time@<version>
  KvStore: oci://ghcr.io/telorun/kv-store-memory@<version>
---
kind: KvStore.Store
metadata: { name: tokenStore }
---
kind: OneTime.Links
metadata: { name: resetLinks }
name: password-reset
store: !ref tokenStore
expiresIn: 30m
reissueAfter: 2m
dataType:
  kind: Telo.JsonSchema
  schema: { type: object, required: [returnTo], properties: { returnTo: { type: string } } }
```

A handler issues with `invoke: { kind: OneTime.Issue, tokens: !ref resetLinks }` and reads the outcome with `result.?token.orValue('')` and `result.?retryAfter.orValue(1)`.

Docs: [token sets](./docs/token-sets.md) · [operations](./docs/operations.md) · [hiding whether an account exists](./docs/hiding-accounts.md)
