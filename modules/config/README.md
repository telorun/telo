# Config

Configuration management for Telo applications: declare where values come from, which keys are accessible, and how to expose them to other modules.

## Why use this

- **Single source of truth** — a `Config.EnvironmentVariableStore` declares the full key set; only declared keys are readable.
- **Variables and secrets split** — `Config.Variables` for plain values, `Config.Secrets` for sensitive ones (redacted in logs and errors).
- **CEL composition** — compose multiple keys into a single value with `${{ ... }}` expressions inside any map value.
- **Fail-fast on missing keys** — missing required values are a hard boot-time error, never a silent `undefined`.
- **One-shot shortcut** — `Config.Env` collapses store + variables + secrets into a single resource for small apps.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Config.EnvironmentVariableStore` | Provider that exposes a declared set of environment-variable keys. |
| `Config.Variables` | Map a subset of store keys to named application values. |
| `Config.Secrets` | Same as `Config.Variables`, but values are redacted in logs and errors. |
| `Config.Env` | Compact one-resource shortcut combining store, variables, and secrets. |

## Example

```yaml
kind: Config.EnvironmentVariableStore
metadata:
  name: Env
schema:
  LOG_LEVEL: { type: string }
  DB_USERNAME: { type: string }
  DB_PASSWORD: { type: string }
  DB_HOST: { type: string }
  DB_PORT: { type: string }
  DB_NAME: { type: string }
  STRIPE_KEY: { type: string }
---
kind: Config.Variables
metadata:
  name: AppConfig
storeRef:
  name: Env
keys:
  logLevel: LOG_LEVEL
---
kind: Config.Secrets
metadata:
  name: AppSecrets
storeRef:
  name: Env
keys:
  stripeKey: STRIPE_KEY
  dbUrl: "${{ DB_USERNAME + ':' + DB_PASSWORD + '@' + DB_HOST + ':' + DB_PORT + '/' + DB_NAME }}"
```

## Reference

- [`Config.Env`](docs/env.md) — single-resource shortcut for small apps.

## Concepts

**Store** — a backend that holds key/value pairs. Declares which keys are accessible via `schema`. Currently supported: `Config.EnvironmentVariableStore`.

**Map** — reads keys from a store and exposes them as named values. Supports direct key lookups and CEL expressions for composing multiple keys into one value. Use `Config.Variables` for plain config, `Config.Secrets` for sensitive values.

**Missing keys** — always a hard boot-time error for both `Config.Variables` and `Config.Secrets`.

## CEL expressions in map values

Use `${{ }}` in any map value to compose multiple store keys into one. All referenced keys must be declared in the store's `schema`:

```yaml
keys:
  dbUrl: "${{ DB_USERNAME + ':' + DB_PASSWORD + '@' + DB_HOST + ':' + DB_PORT + '/' + DB_NAME }}"
```

CEL expressions and direct lookups can be freely mixed. Snapshot exposes `resources.AppSecrets.stripeKey`, `resources.AppSecrets.dbUrl`, etc.

## Passing values into imports

```yaml
kind: Telo.Import
metadata:
  name: Config
source: ./config
variables:
  logLevel: "${{ resources.AppConfig.logLevel }}"
  dbUrl: "${{ resources.AppSecrets.dbUrl }}"
  stripeKey: "${{ resources.AppSecrets.stripeKey }}"
```

## Config.Env shortcut

A compact shortcut that collapses store, variables, and secrets into a single resource — useful for small apps and examples where the three-piece layout is overkill.

```yaml
kind: Config.Env
metadata:
  name: AppConfig
variables:
  port:
    env: PORT
    type: integer
    default: 3000
  logLevel:
    env: LOG_LEVEL
    type: string
    default: info
secrets:
  dbConnection:
    env: DB_CONNECTION
    type: string
  apiKey:
    env: STRIPE_KEY
    type: string
```

Downstream resources reference values the same way as with `Config.Variables` / `Config.Secrets`:

```yaml
connectionString: "${{ resources.AppConfig.dbConnection }}"
port: "${{ resources.AppConfig.port }}"
```

Types supported: `string`, `integer`, `number`, `boolean`. Missing variables without a `default` are a hard boot-time error — identical to the store/map split. Values declared under `secrets` are redacted in logs and error messages.

Pick `Config.Env` for a single-module app that reads the environment directly. Pick the store + map split when multiple maps share a store, when you need CEL composition across keys, or when different key groups are imported into different child modules.

## Notes

- A key not listed in the store's `schema` cannot be read, even in a CEL expression — it will fail at init time.
- Multiple maps can reference the same store.
- CEL expressions have access only to the keys declared in the referenced store.
