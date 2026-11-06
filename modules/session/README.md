# Session

Server-side login sessions kept in a `KvStore.Store`: start one when someone signs in, recognise it on every request, replace it when privileges change, and log a user out of one device or of every device at once. A session expires when idle and at an absolute deadline, can be remembered across browser restarts, and is capped per user.

## Kinds

| Kind | What it is |
| --- | --- |
| `Session.Sessions` | A provider: a set of sessions in a `KvStore.Store` under a durable `name`, with `idleTimeout`, `absoluteLifetime`, optional `persistent` lifetimes and `maxPerSubject`; two sets claiming one name on one store are refused. See [sessions](./docs/sessions.md). |
| `Session.Verifier` | Extends `Auth.Verifier`. Reads `token` presentations — a session cookie fed by `Http.FromCookie`. See [verifier](./docs/verifier.md). |
| `Session.Start`, `Session.Rotate`, `Session.End`, `Session.EndAll`, `Session.List` | The operations on a set. They raise `ERR_SESSION_STORE_UNAVAILABLE` when the store fails (`Start` and `Rotate` also the terminal `ERR_SESSION_STORE_INCONSISTENT`, `Rotate` also `ERR_SESSION_NOT_FOUND`). See [operations](./docs/operations.md). |

The shape `Session.SessionInfo` is exported for contracts.

```yaml
imports:
  Session: oci://ghcr.io/telorun/session@<version>
  Http: oci://ghcr.io/telorun/http-server@<version>
  HttpDispatch: oci://ghcr.io/telorun/http-dispatch@<version>
  KvStoreMemory: oci://ghcr.io/telorun/kv-store-memory@<version>
---
kind: KvStoreMemory.Store
metadata: { name: store }
---
kind: Session.Sessions
metadata: { name: sessions }
store: !ref store
name: web
idleTimeout: 1800s
absoluteLifetime: 43200s
---
kind: HttpDispatch.HostCookie
metadata: { name: sessionCookie }
name: session
---
kind: Session.Verifier
metadata: { name: verifier }
sessions: !ref sessions
```

Mount it with `authentication: { verifiers: [{ verifier: !ref verifier, from: { kind: Http.FromCookie, cookie: !ref sessionCookie, scheme: Session } }] }`; a login route runs `Session.Start` and sets the cookie through its `cookies:` entry. The handler reads `request.principal`.

Docs: [sessions](./docs/sessions.md) · [verifier](./docs/verifier.md) · [operations](./docs/operations.md) · [the cookie](./docs/cookie.md) · [stateless sessions](./docs/stateless.md)
