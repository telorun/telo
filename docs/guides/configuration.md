---
description: "Bind an application to its environment and command line with variables, secrets and ports, pass values into imported libraries, and keep one place that reads the host."
---

# Configuring an application

Anything that differs between your laptop and production is **declared on the
application** and bound to the host — an environment variable, a command-line
argument, or both. There are three blocks, and they all work the same way.

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

Every entry binds `env:` — a `variables:` entry may bind `arg:` instead, or both — and a `variables:` / `secrets:` entry declares a `type:`:

| Key | Meaning |
| --- | --- |
| `env:` | The host environment variable to read. Conventionally `SCREAMING_SNAKE_CASE`. |
| `arg:` | The command-line argument to read — see [Command-line arguments](#command-line-arguments). Not on `secrets:`; beside `env:` on `ports:`. |
| `type:` | `string`, `integer`, `number`, `boolean`, `object`, or `array`. Not written on `ports:` entries — a port is always an integer. |
| `default:` | Used when neither the argument nor the variable is given. An entry with no default is **required**. |
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

## Command-line arguments

The same entry can be bound to the command line with `arg:`. Everything after the
manifest path belongs to the application — `telo run [telo options] ./telo.yaml
[application arguments]`, the way `node [options] app.js [args]` works — and a
packaged application gets every argument after its program name.

```yaml
variables:
  include:
    type: array
    items: { type: string }
    arg: include                    # --include a.yaml --include b.yaml
    default: ["**/tests/*.yaml"]
  verbose:
    type: boolean
    arg: { flag: verbose, short: v } # --verbose / -v / --no-verbose
    env: APP_VERBOSE
    default: false
  target:
    type: string
    arg: { position: 0 }            # the first bare argument…
    env: DEPLOY_TARGET              # …or this, where a runner starts the app
ports:
  http:
    env: PORT
    arg: port                       # --port 9000
    default: 8080
```

```bash
telo run ./telo.yaml --port 9000 --include a.yaml --include b.yaml staging
telo run ./telo.yaml --help        # the usage these bindings describe
```

- **The first source with a value wins**: the command line, then the
  environment variable, then `default:`.
- **Tokens are read by the entry's type** — a repeated flag fills an array, each
  token read by `items.type`; a boolean is `--flag` or `--no-flag`; `--` ends the
  options, so every later token is positional.
- **Nothing undeclared gets through.** An argument no entry binds, a flag with
  its value missing or a value of the wrong type stops the load, in the same
  single report as a missing variable, naming what the application accepts.
- **A secret is never an argument** (`ARG_BINDING_ON_SECRET`): a command line is
  readable in the process table and in shell history.
- **A runner and the studio supply values through the environment**, never the command
  line. So a `ports:` entry always binds `env:`, and a variable bound only by `arg:` needs
  a `default:` (`ARG_BINDING_INVALID` otherwise).

The full grammar is in [Application arguments](/reference/kernel/specs/application-arguments).

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

Only the root application reads the host environment and the command line. A
library receives its values explicitly from whoever imports it — declaring an
`env:` or `arg:` key inside a library is rejected (`LIBRARY_ENV_KEY_REJECTED`,
`LIBRARY_ARG_KEY_REJECTED`). Use the object form of an import entry:

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

That is the whole configuration boundary: one place binds the host, and
everything below it is passed values. See
[Libraries](/learn/libraries).

## Local development

The CLI loads `.env` and `.env.local` automatically, so you rarely export
anything by hand:

```bash
# greeting-api/.env.local
GREETING=Hej
DATABASE_URL=postgres://localhost/dev
```

It reads the manifest's own directory, and — when a `telo-workspace.yaml` sits
somewhere above it — every directory up to and including that one, so a
monorepo keeps shared development values in one file at the root instead of a
copy beside every manifest. The marker's `release.modules` list has no say here,
so a manifest outside every release subtree is covered too. With no marker above
the manifest, only its own directory is read.

A marker can narrow both halves of that — how far the walk climbs, and which
filenames it collects — with an [`env:` block](./workspaces.md#bounding-what-a-run-can-read),
which is how a monorepo keeps one team's `.env` out of another's runs.

The nearest declaration wins — a value in the manifest's directory overrides
the same key at the root, `.env.local` overrides `.env` within one directory,
and a variable already exported in your shell overrides every file. Run with
`--debug` to see which files were loaded; a file that exists but cannot be read
is always reported, whatever the flags.

Keep these files out of version control; they are a developer convenience, not a
configuration mechanism.

## See also

- [Application environment variables](/reference/kernel/application-env-variables) — the normative rules.
- [Application ports](/reference/kernel/application-ports) — protocol brands and wiring checks.
- [Running in production](/deploy/production) — the `TELO_*` variables the runtime itself reads.
