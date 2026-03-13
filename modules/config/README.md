# Config module

The Config module provides configuration management for your application. It lets you declare where config values come from, which keys are accessible, and how to expose them to other modules.

## Concepts

**Store** — a backend that holds key/value pairs. Declares which keys are accessible via `keys`. Currently supported: `Config.EnvironmentVariableStore`.

**Map** — reads keys from a store and exposes them as named values. Supports direct key lookups and CEL expressions for composing multiple keys into one value. Use `Config.Variables` for plain config, `Config.Secrets` for sensitive values.

**Missing keys** — always a hard boot-time error for both `Config.Variables` and `Config.Secrets`.

---

## Config.EnvironmentVariableStore

Reads values from the process environment. Only keys declared in `schema` are accessible to maps.

```yaml
kind: Config.EnvironmentVariableStore
metadata:
  name: Env
schema:
  DB_USERNAME:
    type: string
  DB_PASSWORD:
    type: string
  DB_HOST:
    type: string
  DB_PORT:
    type: string
  DB_NAME:
    type: string
  STRIPE_KEY:
    type: string
```

---

## Maps

### Config.Variables

Reads from a store and exposes named values. Missing keys are a hard boot-time error.

```yaml
kind: Config.Variables
metadata:
  name: AppConfig
storeRef:
  name: Env
keys:
  apiBaseUrl: API_BASE_URL
  logLevel: LOG_LEVEL
```

### Config.Secrets

Identical behavior to `Config.Variables`. Use for sensitive values — secrets are redacted in logs and error messages.

```yaml
kind: Config.Secrets
metadata:
  name: AppSecrets
storeRef:
  name: Env
keys:
  stripeKey: STRIPE_KEY
  dbUrl: "${{ DB_USERNAME + ':' + DB_PASSWORD + '@' + DB_HOST + ':' + DB_PORT + '/' + DB_NAME }}"
```

Snapshot exposes `resources.AppSecrets.stripeKey`, `resources.AppSecrets.dbUrl`, etc.

### CEL expressions

Use `${{ }}` in any map value to compose multiple store keys into one. All referenced keys must be declared in the store's `keys`:

```yaml
keys:
  dbUrl: "${{ DB_USERNAME + ':' + DB_PASSWORD + '@' + DB_HOST + ':' + DB_PORT + '/' + DB_NAME }}"
```

CEL expressions and direct lookups can be freely mixed.

---

## Full example

```yaml
kind: Config.EnvironmentVariableStore
metadata:
  name: Env
schema:
  LOG_LEVEL:
    type: string
  DB_USERNAME:
    type: string
  DB_PASSWORD:
    type: string
  DB_HOST:
    type: string
  DB_PORT:
    type: string
  DB_NAME:
    type: string
  STRIPE_KEY:
    type: string
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
---
kind: Kernel.Import
metadata:
  name: Config
source: ./config
variables:
  logLevel: "${{ resources.AppConfig.logLevel }}"
  dbUrl: "${{ resources.AppSecrets.dbUrl }}"
  stripeKey: "${{ resources.AppSecrets.stripeKey }}"
```

---

## Notes

- A key not listed in the store's `keys` cannot be read, even in a CEL expression — it will fail at init time.
- Multiple maps can reference the same store.
- CEL expressions have access only to the keys declared in the referenced store.
