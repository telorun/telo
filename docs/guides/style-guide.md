---
description: "Naming conventions for Telo identifiers, kinds, imports, and variables to ensure CEL expression correctness"
slug: /guides/style-guide
---

# Telo Official Style Guide: Naming Conventions

Welcome to the Telo Style Guide! While the Telo engine is designed to be highly flexible, following a consistent naming convention ensures that your declarative manifests are readable, maintainable, and seamlessly integrate with the broader Telo module ecosystem.

More importantly, **how you name your resources directly affects how you write CEL (Common Expression Language) expressions.**

## 1. The Golden Rule of Telo Identifiers

**Resource names and import aliases must not contain hyphens (`-`).** In CEL a
hyphen is the subtraction operator, so naming a resource `my-server` makes
`!cel "resources.my-server.url"` unreadable — the expression parses as
`resources.my` _minus_ `server.url`.

Nothing rejects a hyphenated name at load time: `telo check` accepts it, and
the resource initializes. What you lose is the ability to reference it from any
CEL expression, which usually surfaces much later as a confusing type error.
Keep instance names to `^[a-zA-Z_][a-zA-Z0-9_]*$` and the problem cannot arise.

**One name rule _is_ enforced:** a resource name must not contain a dot
(`INVALID_RESOURCE_NAME`). In a `!ref` the first dot separates the import alias
from the resource name (`!ref Console.writeLine`), so a dotted name would
mis-resolve.

---

## 2. Recommended Naming Conventions

While the engine permits any valid alphanumeric string for instances, the official Telo modules (`ghcr.io/telorun/*`) and documentation strictly adhere to the following stylistic rules. We highly recommend you do the same.

### 🟢 `PascalCase` for Instances (Resources & Imports)

Treat your declarative resources and imports as major architectural components (Logical IDs), similar to how AWS CloudFormation names its resources.

- **Do:** MainServer, UsersDb, ProdApi
- **Don't:** mainServer, users_db, prod-api
- **CEL Usage:** `${{ resources.MainServer.url }}`

### 🟢 `PascalCase` for Resource Types (`kind`)

Resource types represent the "Class" or "Blueprint" being instantiated. They should always be capitalized, including namespaces separated by dots.

- **Do:** `Http.Server`, `Db.Postgres`, `Import`, `Module`
- **Don't:** `http.server`, `db.Postgres`

### 🟢 `camelCase` for Properties (`variables`, `secrets`, `exports`)

Data inputs and outputs behave exactly like object properties in JSON/JavaScript.

- **Do:** `dbPassword`, `maxRetries`, `apiUrl`
- **Don't:** `DB_PASSWORD`, `max_retries`, `ApiUrl`
- **CEL Usage:** `!cel "secrets.dbPassword"`

The `env:` key those entries bind to is a host environment variable, and follows
the platform convention instead: `SCREAMING_SNAKE_CASE`.

### 🟢 `PascalCase` for a module's `metadata.name`

A module's `metadata.name` becomes the canonical kind prefix (`MyModule.Thing`)
and is what diagnostics print. It is **not** a locator — imports resolve by
`source`, and `!ref` targets are named by import alias — so treat it as a name,
not a slug.

- **Do:** `OAuthClient`, `HttpServer`
- **Don't:** anything containing a dot — the `!ref` grammar splits on the first one

Older standard-library modules still carry the historical kebab-case form
(`http-server`), which keeps working; new modules should use PascalCase.

### 🟢 `kebab-case` for directories and published repository names

The filesystem directory and the npm / OCI repository name stay URL-friendly —
npm forbids uppercase, and the OCI repository name is the module's directory
name.

- **Do:** `modules/http-server/`, `oci://ghcr.io/telorun/http-server`
- **Don't:** `modules/HttpServer/`, `http_server`

---

## 3. Always write CEL with the `!cel` tag

Every dynamic value is written `!cel "<expression>"` — pure expressions and
string interpolation alike:

```yaml
port: !cel "ports.http"
message: !cel "'Hello, ' + inputs.name + '!'"
```

Do not use the inline `"${{ … }}"` string form in new manifests. The formatter
normalizes to `!cel`, and the inline form does not survive a round-trip through
tooling intact.

## 4. Putting It All Together

A complete manifest applying every rule above:

```yaml
# Module name: PascalCase
kind: Telo.Application
metadata:
  name: MyAwesomeApp
  version: 1.0.0
imports:
  # Import aliases: PascalCase — this is the kind prefix you write below
  Console: oci://ghcr.io/telorun/console@<version>
  Run: oci://ghcr.io/telorun/run@<version>
variables:
  # Property names: camelCase. The env var they bind to: SCREAMING_SNAKE_CASE.
  apiBaseUrl:
    env: API_BASE_URL
    type: string
    default: https://api.example.com
targets:
  - !ref AnnounceStartup
---
# Kind: PascalCase, prefixed by the import alias
kind: Run.Sequence
metadata:
  # Instance name: PascalCase, so it reads cleanly in CEL
  name: AnnounceStartup
steps:
  - name: BuildMessage
    invoke: !ref StartupMessage
  - name: Print
    inputs:
      # steps.<StepName>.result — the step name is PascalCase for the same reason
      output: !cel "steps.BuildMessage.result.text"
    invoke: !ref Console.writeLine
---
kind: Run.Value
metadata:
  name: StartupMessage
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      text: { type: string }
    required: [text]
value:
  text: !cel "'Talking to ' + variables.apiBaseUrl"
```
