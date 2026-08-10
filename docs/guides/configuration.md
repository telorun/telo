---
description: "Bind an application to its environment with variables, secrets and ports, pass values into imported libraries, and keep one place that reads the host environment."
---

# Configuring an application

Anything that differs between your laptop and production is **declared on the
application** and bound to a host environment variable. There are three blocks,
and they all work the same way.

```yaml
kind: Telo.Application
metadata:
  name: MyApp
  version: 1.0.0
ports:
  http:
    env: PORT
    default: 8080
variables:
  apiBaseUrl:
    env: API_BASE_URL
    type: string
    default: https://api.example.com
  maxRetries:
    env: MAX_RETRIES
    type: integer
    default: 3
secrets:
  databaseUrl:
    env: DATABASE_URL
    type: string
```

Each resolves into its own CEL scope:

```yaml
port:    !cel "ports.http"
baseUrl: !cel "variables.apiBaseUrl"
dsn:     !cel "secrets.databaseUrl"
```

## Why declare it instead of reading the environment

- **It fails at load, not at 3am.** A missing required variable stops the whole
  load with a message naming it, before any resource initializes. Every failure
  in the block is aggregated into one report, so you fix them all at once
  instead of one restart at a time.
- **It is typed.** `type: integer` means the string `"3"` arrives as `3`. An
  `object` or `array` value is JSON-decoded from the variable. A value that
  cannot be coerced, or that fails any further JSON Schema keyword you add, is a
  load error.
- **It is visible.** `telo check`, the editor, and anyone reading the manifest
  can see the app's entire configuration surface in one block. A runner knows
  which ports the app exposes without starting it.
- **It cannot be bypassed.** Once a name is declared, reading it straight from
  the process environment inside a controller returns `undefined` by design, so
  a declared binding is the only path.

## Entry shape

Every entry needs `env:` and — for `variables:` / `secrets:` — a `type:`:

| Key | Meaning |
| --- | --- |
| `env:` | The host environment variable to read. Conventionally `SCREAMING_SNAKE_CASE`. |
| `type:` | `string`, `integer`, `number`, `boolean`, `object`, or `array`. Not written on `ports:` entries — a port is always an integer. |
| `default:` | Used when the variable is absent. An entry with no default is **required**. |
| anything else | Any further JSON Schema keyword — `minimum`, `enum`, `pattern`, … — validated at load. |

```yaml
variables:
  logLevel:
    env: LOG_LEVEL
    type: string
    enum: [trace, debug, info, warn, error]
    default: info
  featureFlags:
    env: FEATURE_FLAGS      # FEATURE_FLAGS='{"newCheckout":true}'
    type: object
    default: {}
```

## `variables` vs `secrets`

Same shape, one difference that matters: **values bound to `secrets:` are
redacted from logs automatically**, with no configuration — see
[Logging basics](/learn/logging-basics). Put anything sensitive there — tokens,
connection strings, keys — and non-sensitive configuration in `variables:`.

Telo does not integrate with a secrets manager itself. Inject the values the way
your platform already does (a Kubernetes `Secret`, an ECS task-definition
secret, systemd `EnvironmentFile`, a wrapper that fetches from Vault and
`exec`s `telo`) — see [Security & supply chain](/deploy/security).

## `ports`

`ports:` is application-only and describes what the app **listens on**:

```yaml
ports:
  http:
    env: PORT
    protocol: tcp     # tcp (default) | udp
    default: 8080
```

The value is implicitly a port integer (1–65535), so no `type:` is written. Two
things follow from declaring it rather than hardcoding a number:

- A binding resource reads `!cel "ports.http"` as the single source of truth,
  so the value in the container's `-p` flag and the value the server binds
  cannot drift apart.
- The analyzer brands each port by protocol, so wiring a UDP port into a field
  that wants a TCP one is a static error even though both are integers.

## Passing configuration into an import

Only the root application reads the host environment. A library receives its
values explicitly from whoever imports it — declaring an `env:` key inside a
library is rejected (`LIBRARY_ENV_KEY_REJECTED`). Use the object form of an
import entry:

```yaml
imports:
  Payments:
    source: ./libs/payments
    variables:
      currency: EUR
      apiBaseUrl: !cel "variables.apiBaseUrl"
    secrets:
      apiKey: !cel "secrets.paymentsKey"
```

That is the whole configuration boundary: one place binds the environment, and
everything below it is passed values. See
[Libraries](/learn/libraries).

## Local development

The CLI loads a `.env.local` file from the manifest's directory automatically,
so you rarely export anything by hand:

```bash
# greeting-api/.env.local
GREETING=Hej
DATABASE_URL=postgres://localhost/dev
```

Keep it out of version control; it is a developer convenience, not a
configuration mechanism.

## See also

- [Application environment variables](/reference/kernel/application-env-variables) — the normative rules.
- [Application ports](/reference/kernel/application-ports) — protocol brands and wiring checks.
- [Running in production](/deploy/production) — the `TELO_*` variables the runtime itself reads.
