# Protection

Defences against abuse of sign-in. `Protection.PasswordThrottle` wraps a password checker and bounds failed attempts per user identifier on a `RateLimit.Budget`.

## Kinds

| Kind | What it is |
| --- | --- |
| `Protection.PasswordThrottle` | An `Auth.PasswordVerifier` over `passwords` and `budget`. Counts failures only. See [password throttle](./docs/password-throttle.md). |

```yaml
kind: RateLimit.Budget
metadata: { name: failures }
store: !ref memory
limit: 5
window: 15m
---
kind: Protection.PasswordThrottle
metadata: { name: throttle }
passwords: !ref users
budget: !ref failures
```

Docs: [password throttle](./docs/password-throttle.md)
