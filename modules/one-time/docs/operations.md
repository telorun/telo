# Operations

Each names its set through `tokens:`. Outputs are closed alternatives discriminated by a boolean, as `Auth.PasswordVerifier`'s is, so a member of the branch that is not taken is read with `.?member.orValue(…)`:

```yaml
output: !interpolate "/reset/${{ steps.issue.result.?token.orValue('') }}"
headers: { Retry-After: !cel "string(steps.issue.result.?retryAfter.orValue(1))" }
```

## `OneTime.Issue` (either kind)

Inputs `{ subject, data?, holder? }`; `subject` names who or what the token is for.

- `data` must have the set's `dataType`; `telo check` holds an inline value to it. A set that declares a `dataType` requires `data`: an issue without it is refused as `ERR_INPUT_INVALID` before anything is written.
- `holder` is a value the redeemer must present again, such as an identifier set in the browser that asked. Only its digest is stored.
- Answers `{ issued: true, token, expiresAt }`, or `{ issued: false, retryAfter }` while the subject's previous token is younger than `reissueAfter` (whole seconds, at least 1; the previous token stays live). `token` is sensitive.

## `OneTime.RedeemLink` (links) and `OneTime.RedeemCode` (codes)

`{ token, holder? }` and `{ subject, token, holder? }`. A successful redemption consumes the token and answers `{ redeemed: true, subject, data }`, `data` typed from the set's `dataType` (`null` when the token carried none). Otherwise `{ redeemed: false, reason }`:

| `reason` | Meaning |
| --- | --- |
| `unknown` | Never issued, already used, replaced, revoked, expired, or a code that was exhausted. These are not told apart. |
| `holderMismatch` | The holder differs from the one the token was issued with, or one side has none. It is checked before the token or code and consumes nothing: a code loses no attempt, and the right holder can still redeem. |
| `mismatch` | A wrong code. It uses one attempt. |
| `exhausted` | The wrong code that used the last attempt. The code stops redeeming; later calls are `unknown`. |

## `OneTime.Revoke`

`{ subject }` → `{ revoked }`: withdraws the subject's live token and lets the subject be issued another at once. `revoked: false` when there was none. A code that used up its attempts is not withdrawn — its waiting period still applies, so revoking cannot be used to skip it.

A revoke route that takes the subject from an unauthenticated request lets anyone cancel a pending token and, by freeing the subject, bypass `reissueAfter`; authenticate or bind it.
