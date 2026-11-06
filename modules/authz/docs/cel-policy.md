# Authz.CelPolicy

`rules` is a non-empty list tried in order; the first rule whose `when` is `true` decides. When none matches the answer is `{ allow: false, reason: "no rule matched" }`.

| Rule field | Meaning |
| --- | --- |
| `when` | A boolean CEL expression, evaluated per call. |
| `allow` | The verdict of a matching rule; `true` when omitted. |
| `reason` | Passed through as the decision's `reason`. |
| `requiredScopes` | Passed through as the decision's `requiredScopes`, so the transport can answer `insufficient_scope`. |

## What a rule sees

| Binding | Type |
| --- | --- |
| `principal` | `Auth.Principal`, or `null` for an anonymous request |
| `action` | string |
| `resource` | whatever the caller passed; may be null |
| `context` | object |

The types are checked by `telo check`. Because `principal` can be null, `principal.roles` without a guard is `CEL_NULLABLE_ACCESS`; write `principal != null && 'admin' in principal.roles`. The analysis does not carry an earlier rule's null check into a later one, so each rule guards for itself.

A rule's `when` that does not evaluate to exactly `true` does not match.
