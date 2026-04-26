# Config.Env

> Examples below assume this module is imported with `Telo.Import` alias `Config`. Kind references (`Config.Env`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

Reads values from environment variables and exposes them as named, typed config values to the rest of the module.

Declare `variables` for plain config and `secrets` for sensitive values. Secrets are redacted in logs and error messages. Both sections are resolved at boot time — missing required values are a hard error before anything else starts.

---

## Example

```yaml
kind: Config.Env
metadata:
  name: AppConfig
variables:
  port:
    env: PORT
    type: integer
    default: 3000
    minimum: 1024
  logLevel:
    env: LOG_LEVEL
    type: string
    default: info
    enum: [debug, info, warn, error]
  forcePathStyle:
    env: S3_FORCE_PATH_STYLE
    type: boolean
    default: false
  bucketName:
    env: S3_BUCKET_NAME
    type: string
secrets:
  accessKeyId:
    env: S3_ACCESS_KEY_ID
    type: string
```

After init, values are accessible as `resources.AppConfig.<name>` in CEL expressions elsewhere in the module.

---

## Entry fields

Each entry under `variables` or `secrets` is an object with the following fields:

| Field     | Required | Description                                                                                                        |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `env`     | yes      | Name of the environment variable to read (e.g. `PORT`).                                                            |
| `type`    | yes      | Coerces the resolved string to the target type before validation. One of `string`, `integer`, `number`, `boolean`. |
| `default` | no       | Typed fallback used when the env var is absent. If omitted and the env var is missing, boot fails with an error.   |

Any additional JSON Schema validation keywords (`minimum`, `maximum`, `enum`, `pattern`, etc.) are applied after coercion.

---

## How it works

Each entry names an environment variable via the `env` field. At boot the controller reads `ctx.env[env]`, coerces to the declared `type`, and validates against any additional JSON Schema keywords. If the variable is not set and no `default` is provided, boot fails listing all missing variables.

---

## Snapshot

`Config.Env` exposes a flat snapshot of all resolved values — both `variables` and `secrets` — under the resource name:

```
resources.AppConfig.port             → 3000         (integer)
resources.AppConfig.logLevel         → "info"        (string)
resources.AppConfig.forcePathStyle   → false         (boolean)
resources.AppConfig.bucketName       → "my-bucket"   (string)
resources.AppConfig.accessKeyId      → "AKID..."     (string, redacted in logs)
```

Secret values are registered for redaction in all log output and error messages. Their keys are visible in snapshots but their values are masked.

---

## Type coercion

| `type`    | Coercion                                                    |
| --------- | ----------------------------------------------------------- |
| `string`  | No-op — env vars are already strings                        |
| `integer` | `parseInt(value, 10)` — fails if not a valid integer string |
| `number`  | `parseFloat(value)` — fails if not a valid number string    |
| `boolean` | `"true"` → `true`, anything else → `false`                  |

Coercion happens before JSON Schema validation, so `minimum`, `maximum`, and `enum` compare against the coerced typed value.

---

## Validation errors

All missing and invalid values are collected and reported together in a single boot error, never one at a time:

```txt
Config.Env "AppConfig" failed:
  - bucketName: missing env var S3_BUCKET_NAME
  - port: value "abc" is not a valid integer
  - logLevel: value "verbose" is not one of [debug, info, warn, error]
```
