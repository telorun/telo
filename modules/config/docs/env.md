# Config.Env

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
    value: "${{ env.PORT }}"
    type: integer
    default: 3000
    minimum: 1024
  logLevel:
    value: "${{ env.LOG_LEVEL }}"
    type: string
    default: info
    enum: [debug, info, warn, error]
  forcePathStyle:
    value: "${{ env.S3_FORCE_PATH_STYLE }}"
    type: boolean
    default: false
  bucketName:
    value: "${{ env.S3_BUCKET_NAME }}"
    type: string
secrets:
  accessKeyId:
    value: "${{ env.S3_ACCESS_KEY_ID }}"
    type: string
  connectionString:
    value: "${{ 'postgres://' + env.DB_USER + ':' + env.DB_PASSWORD + '@' + env.DB_HOST + ':' + env.DB_PORT + '/' + env.DB_NAME }}"
    type: string
```

After init, values are accessible as `resources.AppConfig.<name>` in CEL expressions elsewhere in the module.

---

## Entry fields

Each entry under `variables` or `secrets` is an object with the following fields:

| Field     | Required | Description                                                                                                                         |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `value`   | yes      | CEL expression evaluated with `env` as context. Use `${{ env.VAR_NAME }}` for direct lookups or any CEL expression for composition. |
| `type`    | yes      | Coerces the resolved string to the target type before validation. One of `string`, `integer`, `number`, `boolean`.                  |
| `default` | no       | Typed fallback used when the env var is absent. If omitted and the env var is missing, boot fails with an error.                    |

Any additional JSON Schema validation keywords (`minimum`, `maximum`, `enum`, `pattern`, etc.) are applied after coercion.

---

## CEL context

Inside `value` expressions, `env` is `process.env` — a map of all environment variables. Access a variable with `env.VAR_NAME`.

Compose multiple env vars in one value:

```yaml
connectionString:
  value: "${{ 'postgres://' + env.DB_USER + ':' + env.DB_PASSWORD + '@' + env.DB_HOST }}"
  type: string
```

If any referenced env var is absent and has no `default`, boot fails listing all missing variables.

---

## Snapshot

`Config.Env` exposes a flat snapshot of all resolved values — both `variables` and `secrets` — under the resource name:

```
resources.AppConfig.port             → 3000         (integer)
resources.AppConfig.logLevel         → "info"        (string)
resources.AppConfig.forcePathStyle   → false         (boolean)
resources.AppConfig.bucketName       → "my-bucket"   (string)
resources.AppConfig.accessKeyId      → "AKID..."     (string, redacted in logs)
resources.AppConfig.connectionString → "postgres://..." (string, redacted in logs)
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
