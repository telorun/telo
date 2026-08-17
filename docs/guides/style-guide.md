---
description: "Naming conventions for Telo identifiers, kinds, imports, and variables to ensure CEL expression correctness"
slug: /learn/style-guide
---

# Style guide

Welcome to the Telo Style Guide! While the Telo engine is designed to be highly flexible, following a consistent naming convention ensures that your declarative manifests are readable, maintainable, and seamlessly integrate with the broader Telo module ecosystem.

More importantly, **how you name your resources directly affects how you write CEL (Common Expression Language) expressions.**

## 1. The rule, in one sentence

**Case encodes what a name denotes.** `PascalCase` names a **type** — something
you can write in a `kind:`, `extends:`, or type slot. `camelCase` names a
**value** — something that holds data at runtime and is read through a CEL scope
(`resources.`, `steps.`, `variables.`).

That single distinction is what tells `kind: Console.WriteLine` (a type) apart
from `!ref Console.writeLine` (an instance of it). The two are otherwise
character-identical, and the pair is common: a library declares
`kind: Self.WriteLine`, exports the *instance* and withholds the kind, so both
names exist side by side.

## 2. What is enforced

Unlike Rust, Telo has no lexer — a name is a YAML scalar, so nothing rejects its
shape where you write it. `telo check` therefore enforces the rule in three
tiers:

| Diagnostic | Severity | What it catches |
| --- | --- | --- |
| `INVALID_NAME` | error | A name that is not `^[A-Za-z_][A-Za-z0-9_]*$`, or is a CEL keyword. |
| `INVALID_TYPE_NAME` | error | A type-level name not starting uppercase. |
| `NAME_CASE_CONVENTION` | warning | A value-level name not starting lowercase. |

The first tier is an error because the name is otherwise **unreferenceable, or
silently mis-referenced**. A hyphen is the case that matters: CEL reads `-` as
subtraction, so `!cel "resources.my-server.url"` parses as `resources.my` _minus_
`server.url`. Where a bare name happens to be in scope — which named
[CEL bindings](./refs-and-cel.md) make possible — that **evaluates to a wrong
number with no diagnostic at all**. A dot is the same class: in a `!ref` the
first dot separates the import alias from the name.

The second tier is an error because the alias-qualified `<Alias>.<Kind>` grammar
already accepts only PascalCase, so a lowercase kind is one nothing can
`extends:`.

The third is only a **warning**, deliberately. A name is occasionally dictated
from outside, and Telo has no way to silence a diagnostic locally, so the
convention applies pressure without becoming a wall.

**Only the first character is checked.** `httpApi` and `httpAPI` are both fine,
as are `OAuthClient` and `OauthClient`; an all-acronym type name like `SQL` or
`AI` passes unchanged. The first character carries the type/value signal, and a
stricter rule would only relitigate spellings nobody needs settled.

There is no automatic fix. A rename is correct only when every reference moves
with it, and a quick fix rewrites one node — so renaming is a refactor, not a
repair.

---

## 3. The conventions in full

### 🟢 `camelCase` for instances, steps and properties

Everything read through a CEL scope: resource `metadata.name`, `Run` step names,
and the keys of `variables:` / `secrets:` / `ports:`.

- **Do:** `mainServer`, `usersDb`, `buildMessage`, `dbPassword`, `maxRetries`
- **Don't:** `MainServer`, `users_db`, `prod-api`, `DB_PASSWORD`
- **CEL usage:** `!cel "resources.mainServer.url"`, `!cel "secrets.dbPassword"`

The `env:` key a `variables:` / `secrets:` / `ports:` entry binds to is a host
environment variable, and follows the platform convention instead:
`SCREAMING_SNAKE_CASE`.

### 🟢 `PascalCase` for kinds, modules and import aliases

Resource types are the "class" being instantiated; a module name is the
canonical kind prefix (`MyModule.Thing`); an import alias stands for a module,
so it is the namespace you write that prefix as.

- **Do:** `Http.Server`, `OAuthClient`, `HttpServer`, `Console: oci://…`
- **Don't:** `http.server`, `db.Postgres`, `console: oci://…`

A module's `metadata.name` is **not** a locator — imports resolve by `source`,
and `!ref` targets are named by import alias — so treat it as a name, not a
slug.

### 🟢 `PascalCase` for a named shape

A resource whose kind's capability is `Telo.Type` (a `Telo.JsonSchema`, say) has
no runtime instance: its name denotes a shape, referenced from `inputType:` /
`outputType:`. So it is type-level despite being declared as a resource.

- **Do:** `Order`, `CreateUserRequest`
- **Don't:** `order`, `createUserRequest`

### 🟢 `kebab-case` for directories and published repository names

The filesystem directory and the npm / OCI repository name stay URL-friendly —
npm forbids uppercase, and the OCI repository name is the module's directory
name.

- **Do:** `modules/http-server/`, `oci://ghcr.io/telorun/http-server`
- **Don't:** `modules/HttpServer/`, `http_server`

---

## 4. Always write CEL with the `!cel` tag

Every dynamic value is written `!cel "<expression>"` — pure expressions and
string interpolation alike:

```yaml
port: !cel "ports.http"
message: !cel "'Hello, ' + inputs.name + '!'"
```

Do not use the inline `"${{ … }}"` string form in new manifests. The formatter
normalizes to `!cel`, and the inline form does not survive a round-trip through
tooling intact.

## 5. Putting it all together

A complete manifest applying every rule above:

```yaml
# Module name: PascalCase — it is the canonical kind prefix
kind: Telo.Application
metadata:
  name: MyAwesomeApp
  version: 1.0.0
imports:
  # Import aliases: PascalCase — this is the kind prefix you write below
  Console: oci://ghcr.io/telorun/console@<version>
  Run: oci://ghcr.io/telorun/run@<version>
variables:
  # Declaration names: camelCase. The env var they bind to: SCREAMING_SNAKE_CASE.
  apiBaseUrl:
    env: API_BASE_URL
    type: string
    default: https://api.example.com
targets:
  - !ref announceStartup
---
# Kind: PascalCase, prefixed by the import alias
kind: Run.Sequence
metadata:
  # Instance name: camelCase — it names a value, read as resources.announceStartup
  name: announceStartup
steps:
  - name: buildMessage
    invoke: !ref startupMessage
  - name: print
    inputs:
      # steps.<stepName>.result — camelCase for the same reason
      output: !cel "steps.buildMessage.result.text"
    invoke: !ref Console.writeLine
---
kind: Run.Value
metadata:
  name: startupMessage
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
