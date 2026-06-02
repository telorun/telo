---
description: "How Telo.Application declares variables and secrets sourced from host environment variables, with per-field env mapping, type coercion, and schema validation."
---

# Application environment variables

`Telo.Application` accepts `variables:` and `secrets:` blocks whose entries bind directly to host environment variables. Values resolve at `kernel.load()` into the root module's `variables.X` / `secrets.X` CEL scope, so resources can read them with `!cel "variables.port"` without an intermediate `Config.Env` resource.

This is the recommended way to wire host environment into a manifest. `Config.Env` remains supported for backwards compatibility but is deprecated.

---

## Quick example

```yaml
kind: Telo.Application
metadata:
  name: my-api
  version: 1.0.0

variables:
  port:
    env: PORT
    type: integer
    minimum: 1024
    default: 3000
  logLevel:
    env: LOG_LEVEL
    type: string
    enum: [debug, info, warn, error]
    default: info

secrets:
  databaseUrl:
    env: DATABASE_URL
    type: string

targets: [Server]
---
kind: Http.Server
metadata: { name: Server }
port: !cel "variables.port"
---
kind: Sql.Connection
metadata: { name: Db }
url: !cel "secrets.databaseUrl"
```

Running this manifest with `PORT=8080 LOG_LEVEL=debug DATABASE_URL=postgres://… telo run ./manifest.yaml` populates `variables.port = 8080`, `variables.logLevel = "debug"`, and `secrets.databaseUrl = "postgres://…"`.

---

## Entry shape

Each entry under `variables:` / `secrets:` is a single object that combines the env-var binding with a JSON Schema fragment describing the typed value:

| Field        | Required | Description                                                                                                                                                                                                  |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env`        | yes      | Name of the host environment variable to read.                                                                                                                                                               |
| `type`       | yes      | One of `string`, `integer`, `number`, `boolean`, `object`, `array`. Drives the coercion rule applied to the raw env-var string.                                                                              |
| `default`    | no       | Typed fallback used when the env var is unset. If omitted and the env var is missing, `kernel.load()` fails with `ERR_MANIFEST_VALIDATION_FAILED`.                                                           |
| _any other_  | no       | Standard JSON Schema keywords applied after coercion — `minimum`, `maximum`, `enum`, `pattern`, `format`, `properties`, `required`, `items`, `minItems`, `oneOf`, … Apply only those that match the `type:`. |

The `env:` key is the only thing that distinguishes Application entries from Library entries. Same block names, same CEL access, same author-facing shape — Application carries `env:` per field; Library entries do not.

---

## Type coercion

| `type`    | Coercion                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `string`  | Identity — env vars are already strings.                                                                                                                                  |
| `integer` | Trim whitespace, require match against `^-?\d+$`, then `parseInt(value, 10)`. Non-integer strings fail with a coercion error.                                             |
| `number`  | `parseFloat(value)`. `NaN` fails with a coercion error.                                                                                                                   |
| `boolean` | `"true"` → `true`; `"false"` → `false`. Anything else fails with a coercion error.                                                                                        |
| `object`  | `JSON.parse(value)`. The parsed value must be a JSON object (`{ … }`); other top-level types (array, number, string, …) fail with `"expected JSON object, got <type>"`.   |
| `array`   | `JSON.parse(value)`. The parsed value must be a JSON array (`[ … ]`); other top-level types fail with `"expected JSON array, got <type>"`.                                |

After coercion, the value is validated against the residual JSON Schema (the entry with `env` and `default` stripped) using a standard JSON Schema draft 2020-12 validator.

Object and array types are useful when a single env var needs to carry structured config:

```yaml
variables:
  tls:
    env: SERVER_TLS
    type: object
    properties:
      cert: { type: string }
      key: { type: string }
    required: [cert, key]
  origins:
    env: ALLOWED_ORIGINS
    type: array
    items: { type: string }
    minItems: 1
```

```sh
SERVER_TLS='{"cert":"abc","key":"def"}' ALLOWED_ORIGINS='["https://a","https://b"]' telo run ./manifest.yaml
```

---

## Error aggregation

Every error encountered during env-var resolution — missing required entries, coercion failures, schema violations — is collected and reported in a single `ERR_MANIFEST_VALIDATION_FAILED` error before any controller initializes. You see all problems at once instead of failing fast on the first one:

```txt
Application environment validation failed:
  - port: environment variable PORT is not set (no default)
  - logLevel: must be equal to one of the allowed values (debug | info | warn | error)
  - tls: environment variable SERVER_TLS: value is not valid JSON: …
```

---

## Unused declarations

A declared `variables` / `secrets` / `ports` entry that no CEL expression references is flagged by the analyzer with an `UNUSED_DECLARATION` warning — dead config at best, and for `ports` actively misleading (a runner would advertise a port the app never listens on). The check is Application-only: a `Telo.Library`'s entries are a public contract consumed by its controllers, so they are not flagged.

## Ports

`Telo.Application` also declares the inbound ports it listens on via a `ports:` block — env-bound like `variables`, but specialised for ports (implicit integer in the 1–65535 range, its own `ports.<name>` CEL scope, and transport brands for static wiring checks). See [Application Ports](./application-ports.md).

---

## Library variables — no env binding

`Telo.Library` `variables:` / `secrets:` entries are pure JSON Schema property maps. Libraries receive values from their importer (the parent Application's `imports:` entry), never from host env directly. An `env:` key on a Library entry is rejected at load time:

```txt
Telo.Library variables/<name>: 'env:' is only permitted on Telo.Application entries.
Libraries must receive values from importers via the parent manifest's variables / secrets block.
```

If a Library needs an env-derived value, the importing Application declares the env binding and passes the resolved value through its `imports:` entry's `variables:` block.

---

## Migration from Config.Env

`Config.Env` snapshots typed env values under `resources.<Name>.X`; Application-level entries land in the root `variables.X` / `secrets.X` scope. To migrate:

1. Lift each entry from the `Config.Env` resource into the Application's `variables:` / `secrets:` block.
2. Replace `${{ resources.AppConfig.port }}` references with `${{ variables.port }}` (or `${{ secrets.<name> }}` for secret entries).
3. Delete the `Config.Env` resource.

```yaml
# Before
kind: Config.Env
metadata: { name: AppConfig }
variables:
  port:
    env: PORT
    type: integer
    minimum: 1024
---
kind: Http.Server
port: !cel "resources.AppConfig.port"

# After
kind: Telo.Application
variables:
  port:
    env: PORT
    type: integer
    minimum: 1024
targets: [Server]
---
kind: Http.Server
metadata: { name: Server }
port: !cel "variables.port"
```
