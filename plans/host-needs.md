# Host needs

A module declares what it needs from whatever runs it — a backing service, durable storage, its public address, a generated secret — as typed inputs. The kernel fills each one from the environment at load, or refuses to boot naming the variables to set. Whoever starts the process — a person, a runner, Telo Cloud — reads a static report of those needs and provisions them before start. Nothing is fetched or provisioned at boot, and a kernel makes no network call to fulfil a need.

## Concepts

| Concept | What it is |
|---|---|
| Need type | A kind (`Postgres.DatabaseAccess`) describing something a module can ask for: the fields a fulfilment hands over, the parameters and features a request may state, and whether it is versioned. Any library may export one. |
| Need | A module's request for a fulfilment of a need type, written under `needs:`. It names the type and optional constraints, never where the fulfilment comes from. |
| Fulfilment | The values that satisfy a need: every required field of its type, such as a database's URL. |
| Self-supplied fulfilment | A fulfilment the module writes itself, as a resource of the need-type kind carrying `fields:`. |
| Need path | Where a need sits in the import tree: its name beneath each importer's alias (`Orders.databaseAccess`). |
| Need env name | The environment variable one field of a need is read from at the root: bound by the root's `env:`, otherwise derived from the need path. |
| Host value | One of three `TELO_HOST_*` variables a host may set, from which the kernel answers the three kernel-declared need types. |
| Needs report | The static list of every need a root still takes from the environment, produced with nothing booted. It is what an operator provisions from. |

## Before

- A backing service is a hand-filled `variables:` / `secrets:` entry. Nothing says "this is a PostgreSQL 15 with pgvector", so no operator can tell what to provide without reading the code.
- A library's backing service must be redeclared and forwarded by every application that imports it.
- A directory that must survive a restart, the application's own public URL and a key that must be generated once are ordinary values the operator has to know to provide. A routed runner session's public URL is not known until the session exists, so nothing can provide it.
- `connectionString` is a bare string; a URL assembled from a generated password breaks on `@` or `/`.

## After

### Need types

- `kind: Telo.NeedType` registers a kind `<Module>.<Name>`, exported through `exports.kinds` and gated like any other. Any library may export one, so the vocabulary is open by publication and Telo owns no list.
- A type owns `fields` (a JSON Schema property map of what a fulfilment hands over; a field may be `x-telo-sensitive: true` and carry an `x-telo-type`), `parameters` (the schema of what a need may ask), `features` (the closed list of feature names), and `version: semver` when fulfilments are versioned.
- A type's identity is its declaring module's location plus its name, independent of the module's version. Types evolve additively.
- A need type is named for what its fulfilment hands over. It is `<Thing>Access` when that is the address and credentials of something outside the application, `<Thing>` being the exact unit the credentials are scoped to: `Postgres.DatabaseAccess`, `Redis.ServerAccess`, `S3.BucketAccess`, `OpenAI.ApiAccess`. It is the bare noun when the fulfilment is the thing itself on the host. The name of the object itself stays free for a kind that creates or owns it.
- The kernel declares three types: `Telo.GeneratedSecret`, `Telo.DurableDirectory` and `Telo.PublicUrl` (see Kernel-declared types).

### `Telo.Url`

- A new value type for a URL that may carry credentials. It is written as its text (`postgres://app:…@db.internal:5432/orders`) or as an object — `scheme`, `host`, `port`, `user`, `password`, `path`, `query` — whose members the type escapes, so nobody assembles a URL out of a generated password.
- In CEL it is a nominal type, not a `string`: its members are read by name, and `string(url)` is its text. The `password` member is sensitive on its own, so reading `host` is never redacted, and reading `password` or the whole text always is.
- A string is accepted wherever a `Telo.Url` is expected, parsed as its text: an env value, a `string` variable or secret, or any string expression at a `Telo.Url` field.
- A string literal that does not parse is `URL_INVALID` at `telo check`. A computed string that does not parse is `ERR_URL_INVALID` when its resource is created, and an env value that does not parse is `ERR_URL_INVALID` at load. Each names the field, or the variable the value came from, and never prints the value.

### Declaring a need

- `needs:` is a block on a `Telo.Application` or `Telo.Library` doc, keyed by a camelCase name.
  - An entry has `kind: <Alias>.<Name>`.
  - It may add `version` (a range in the `requires:` comparator grammar, legal only when the type is versioned), `features` (a subset of the type's list), `parameters` (literals) and `optional: true`.
- An entry is a declaration of that kind in the module's scope, as a Library `resources:` entry is. It shares the module's one namespace (`DUPLICATE_RESOURCE_NAME`) and is named by `!ref <name>`.
- The two blocks stay separate contracts. A `resources:` entry is a live instance its importer must hand over; a `needs:` entry is a value any level up to the environment may supply. A Library `resources:` entry whose kind is a need type is `RESOURCE_INPUT_NEED_TYPE` (`ERR_RESOURCE_INPUT_NEED_TYPE`), with the repair "declare it under `needs:`".
- A field is read as `resources.<name>.<field>`, typed from the need type and closed to its fields, and readable at startup in `!cel` and in every `!interpolate` hole. A whole fulfilment is handed over only by `!ref`.
- A fulfilment is always every required field of its type, delivered to the module instance that declared the need.
- A field keeps its type and its sensitivity: a sensitive field is redacted wherever it is read, as a `secrets.` value is.
- An optional need is nullable, and reading it unguarded is `CEL_NULLABLE_ACCESS`.

### A kind that consumes a need

- A kind that takes a whole fulfilment declares an ordinary reference slot: `x-telo-ref: { kind: Self.<NeedType>, use: dependency }`. The slot accepts a need or a self-supplied fulfilment of that kind, and nothing else.
- A need of another kind at the slot is `REFERENCE_KIND_MISMATCH`; a non-reference is `INVALID_REFERENCE_FORM`; a computed value is `REF_SLOT_COMPUTED`.
- A `!ref` to an `optional: true` need at a kind's reference slot is `NEED_OPTIONAL_REFERENCED` (`ERR_NEED_OPTIONAL_REFERENCED`). An optional need is consumed by guarded field reads, or forwarded to a need that is itself optional.
- **The consumer verifies the constraints.** The controller resolving the slot receives the fields together with the need's stated `version` range and `features`. A kind consuming a versioned type, or one with features, checks them against the real thing on the first connection it makes anyway, and refuses with `ERR_NEED_UNMET` naming the need, where its value came from (the env name, or the supplying declaration), and the required against the actual. The SDK carries one constructor for that refusal, so every consumer words it the same way.
- A fulfilment the consumer cannot reach fails as that consumer fails today, never as `ERR_NEED_UNMET`. A need read only through field reads is not verified: its constraints are a request to whoever provides it.
- A slot that holds one scalar — a file path, an API key — keeps taking one field by CEL.

### A fulfilment held by the module

- A resource declared with `kind: <need type>` carries `fields:`. It must yield every required field of the type (`NEED_SLOT_MISMATCH`), and a key the type does not declare is `NEED_FIELD_UNDECLARED`.
- Each value is a literal, or startup `!cel` / `!interpolate` over `variables`, `secrets` and other resources' startup-readable readings; observed state stays refused there. A `Telo.Url` field is written in its object form, each member a literal or CEL.
- It is an ordinary configured resource in the init order. It satisfies the same reference slot and is read the same way as a need, and it never appears in the needs report.
- A need-type kind has no capability a `targets:` entry accepts.

### Bubbling and supply at an import

- A need nobody supplies bubbles up the import closure to the root. An application author writes nothing for a need they neither use nor override.
- An import entry's `needs:` map supplies a library's need in one of two forms:
  - whole, by a `!ref` to a need or a self-supplied fulfilment of that kind in the importer;
  - field by field, each field a literal or CEL (`url: !cel "resources.databaseAccess.url"`). This form is a self-supplied fulfilment written anonymously, so an importer supplies a need without importing the module that exports its type.

  A supplied need leaves the report.
- A key the target does not declare is `NEED_UNDECLARED`.
- A need forwarded whole to a need whose `version` range it does not lie within, or whose `features` it does not include, is `NEED_FORWARD_INCOMPATIBLE`.
- A fulfilment belongs to a module instance. An `isolated` library gets one per import. A `shared` library gets one for the whole application, and what its importers forward joins the existing rule that every import of a shared library must agree.
- A need path is the need's name beneath each importer's alias, dot-separated.

### Supplying a need from the environment

- The kernel reads every need that reaches the root unsupplied from the environment at load, before any resource initializes. That is the only door: no host, supplier or network is asked.
- **Each field has exactly one env name.**
  - A root Application's own `needs:` entry may bind names explicitly, with `env: { <field>: <NAME> }`.
  - Every other field takes a derived name: `TELO_NEED_`, then the need path's segments, then the field. Word boundaries in camelCase and PascalCase become `_`, letters are upper-cased, and segments and the field are joined by `__`. `Orders.databaseAccess` field `url` is `TELO_NEED_ORDERS__DATABASE_ACCESS__URL`; a root need `sessionKey` field `value` is `TELO_NEED_SESSION_KEY__VALUE`.
  - A bound name replaces the derived one; the two are never both read.
- Precedence is fixed: a `needs:` supply at an import, then the field's env name, then — for a kernel-declared type only — the host values.
- An env value is decoded against the field's schema as a root variable's is: `Telo.Url` parsed, `Telo.HostPath` resolved against the working directory, integers and booleans read as such.
- When any env name of a need is set, every required one must be (`ERR_NEED_PARTIALLY_SUPPLIED`). A required need with none set, and no host value for its type, is `ERR_NEED_UNMET` before any resource initializes. The refusal names the need path, its type, the declaring module and every env name to set. An optional need with none set is null.
- An `env:` key naming no field of the type is `NEED_FIELD_UNDECLARED`. An `env:` map on a root need must bind every required field of the type (`NEED_SLOT_MISMATCH`).
- Two need fields with one env name, bound or derived, or one equal to a `variables` / `secrets` / `ports` env name, is `NEED_ENV_NAME_COLLISION`.
- A library cannot bind env (`LIBRARY_ENV_KEY_REJECTED`). Its needs are reached by their derived names, or the root declares a need of its own with `env:` and forwards it at the import.
- A need's env name reads `undefined` from the process environment inside the workload, as a bound variable's does. No controller reads a need from the environment itself.

### Kernel-declared types

The kernel answers these three types from host values when the environment has not supplied them. A host sets the values it can, and the kernel derives each fulfilment from them locally, so no host needs to read a manifest.

| Type | Parameters | Field | Answered from |
|---|---|---|---|
| `Telo.GeneratedSecret` | `bytes` (default 32) | `value`, sensitive: the bytes as base64url text | `TELO_HOST_SECRET_SEED` (32 bytes, base64url): HKDF-SHA256 over the seed with the need path as `info` |
| `Telo.DurableDirectory` | `size`, `access: single-writer \| shared` | `path`, a `Telo.HostPath` | `TELO_HOST_STATE_DIR`: the directory `<state dir>/needs/<need path>`, created at load when absent |
| `Telo.PublicUrl` | `port`, a key of the root's `ports:` | `url`, a `Telo.Url` | `TELO_HOST_PUBLIC_URL_TEMPLATE`: the template with `{port}` replaced by that port's number |

- A value is a pure function of the host value and the need path. The same seed, state directory and template give the same secret, directory and URL on every restart, reload and resume, with nothing stored.
- `size` and `access` are not enforced by the kernel. They are listed in the report for whoever provides the storage.
- Renaming a need, or an importer's alias, gives it a new path, and so a new secret and a new directory. At load, a directory under `<state dir>/needs/` that no declared path names is an orphan. When the load would create a fresh `Telo.DurableDirectory` while an orphan exists, it is refused with `ERR_NEED_DIRECTORY_ORPHANED` before any resource initializes, naming both paths; the repair is to move the directory or delete it. Otherwise the orphan is a `NEED_DIRECTORY_ORPHANED` warning. Nothing is moved or deleted automatically.
- A host value that does not decode is `ERR_NEED_HOST_VALUE_INVALID`, naming the variable and never printing its value. A template without `{port}` is invalid.
- A library declares `Telo.PublicUrl` without `port`, having no `ports:` of its own. The root declares its own `Telo.PublicUrl` naming a port and forwards it at the import. A `Telo.PublicUrl` reaching the root with no port, a key `ports:` does not hold, or a `udp` port is `NEED_PARAMETERS_INVALID`.
- The CLI sets no host value. Locally these types are supplied by their env names, or by a user who sets the host values themselves.

### The needs report

- `telo needs report <manifest>` prints, with nothing booted, one entry per need that reaches the root unsupplied. Each entry gives:
  - its path, declaring module, type, version range, features, parameters, and whether it is optional;
  - per field: its env name, whether it was bound or derived, and whether it is sensitive.

  It carries no values.
- Under `-o json` it writes a versioned document, `reportVersion: 1`, with fields added within a version:
  - `needs` is a list whose entries carry `path`, `declaredBy`, `type` (`{ module, name }`), `version`, `features`, `parameters`, `optional` and `fields`;
  - `fields` is keyed by field name, each carrying `env`, `envSource` (`bound` | `derived`), `required` and `sensitive`.
- The report is what an operator provisions from. Telo Cloud reads it with the CLI of the release the module is published for, provisions each entry for the stage and sets its env names. That service is outside this repository; the report document, the env-name rule and the host values are the contract it relies on.
- `report` is the only `telo needs` verb.

### Started applications

- `App.Instance` gains `needs:`, taking the two forms an import's map takes. Like its `variables` / `secrets` / `ports`, a key the child does not declare is refused when it starts (`ERR_MANIFEST_VALIDATION_FAILED`, naming the declared set).
- A child is a root of its own: a need it leaves unsupplied is read from its own env names, and its report is its own.

### Runners

A runner sets host values on every application container of a session. It reads no manifest and no report.

- **Docker runner**:
  - mints a `TELO_HOST_SECRET_SEED` per session;
  - mounts a named volume per session at a fixed path, naming that path in `TELO_HOST_STATE_DIR`.
- **k8s runner**:
  - does the same over a PersistentVolumeClaim per session;
  - sets `TELO_HOST_PUBLIC_URL_TEMPLATE` when the session is routed (`https://{port}-<session id>.<base domain>`).
  - It delivers the seed through a Secret reference, so no value appears in the pod spec.
- **Local-process runner backend**: mints a seed and gives `TELO_HOST_STATE_DIR` a directory it owns per session.
- The seed is retained with the session's launch, as its tokens are, so resume and a changed app set keep it. The volume outlives suspension.
- Deleting the session removes its volume and its seed. A runner's boot-time reaping of orphaned workloads removes the volumes of sessions that are gone, as a runner restart already loses those sessions.
- Every other need type in a session comes from the session's `env`. A session missing one starts and the kernel refuses with `ERR_NEED_UNMET`, naming the env names to set.

### PostgreSQL

- `postgres` exports `Postgres.DatabaseAccess`: `version: semver`, `features: [pgvector, postgis]`, one field `url`, a sensitive `Telo.Url`.
- `Postgres.Connection` gains `access`, a reference to `Self.DatabaseAccess`. When the connection first proves itself at init, it reads the server version and the installed extensions and verifies the need's constraints.
- `connectionString` stays, deprecated, so an existing application keeps validating after it upgrades `postgres`. Two `x-telo-resource-rules` express this with no new mechanism, both `RESOURCE_RULE_VIOLATED`, the kernel enforcing the error at creation:
  - writing both fields, or neither, is an error;
  - writing `connectionString` is a warning naming `access` as its replacement.

  Removing the field is a later release.
- Every stdlib module with a backing service follows the same pattern as it is touched: the module that opens the connection exports the need type and a slot referencing it, beside its deprecated connection field.

### Tests

- A test supplies the needs of the application it starts through `App.Instance`'s `needs:`, with literals, a self-supplied fulfilment, or a `!ref` to a need of the test's own.
- An integration test needing a real database declares a self-supplied `Postgres.DatabaseAccess` over the `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` variables the integration suite already binds.
- The root suite covers verification with a fixture need type whose consumer kind checks a version it is handed, so it needs nothing running.

### Refusals

Reported by `telo check`, with kernel twins where one is named:

| Code | When |
|---|---|
| `NEED_TYPE_UNRESOLVED` | a `needs:` entry's `kind:` naming no exported need type |
| `NEED_PARAMETERS_INVALID` | parameters, features or a version range the type does not admit; a `Telo.PublicUrl` at the root naming no port, a key `ports:` does not hold, or a `udp` port |
| `NEED_FIELD_UNDECLARED` | a key of a field-by-field supply map, of `fields:` or of an `env:` map that the type does not declare |
| `NEED_SLOT_MISMATCH` | `fields:` or a field-by-field supply map not yielding every required field; a root `env:` map not binding every required field |
| `RESOURCE_INPUT_NEED_TYPE` / `ERR_RESOURCE_INPUT_NEED_TYPE` | a Library `resources:` entry whose kind is a need type |
| `NEED_OPTIONAL_REFERENCED` / `ERR_NEED_OPTIONAL_REFERENCED` | a `!ref` to an optional need at a kind's reference slot |
| `NEED_FORWARD_INCOMPATIBLE` | a need forwarded whole to a need whose version range or features it does not cover |
| `NEED_UNDECLARED` | a `needs:` key at an import that the target does not declare |
| `NEED_ENV_NAME_COLLISION` | two need fields with one env name, or one equal to a `variables` / `secrets` / `ports` env name |
| `URL_INVALID` / `ERR_URL_INVALID` | a string at a `Telo.Url` field that does not parse — a literal at check, a computed value at creation, an env value at load |

Reported at run:

| Code | When |
|---|---|
| `ERR_NEED_UNMET` | a required need with no supply, no env value and no host value, before any resource initializes, naming the path, type, declaring module and env names; or a consumer finding a fulfilment's version or features do not satisfy the need, naming its source and required against actual |
| `ERR_NEED_PARTIALLY_SUPPLIED` | some but not all required env names of a need set |
| `ERR_NEED_HOST_VALUE_INVALID` | a `TELO_HOST_*` value that does not decode |
| `ERR_NEED_DIRECTORY_ORPHANED` / `NEED_DIRECTORY_ORPHANED` | an orphan directory under the state directory when a fresh `Telo.DurableDirectory` would be created; a warning otherwise |

A field read the type does not declare is the existing `CEL_UNKNOWN_FIELD`, and a wrong kind at a consuming slot the existing `REFERENCE_KIND_MISMATCH`. The refusals the analyzer and kernel own get rows in the check/run agreement suite. `postgres`'s two resource rules are pinned in its own tests: refused at the declaring library, and `runFails:` from a silent consumer.

## Constraints from work not in this plan

- **Grants.** A fulfilled field is the scope of a derived grant: a bound host is outbound access to it, a directory is write access. So values are delivered only to the module instance that declared the need, no controller reads them from the process environment, and an address is a `Telo.Url` whose `host` and `port` a grant reads without parsing text.
- **Compute estimate.** The report is versioned and extensible because it is the document a later CPU/memory estimate joins.

## Order of work

Every module adopting new surface — `needs:`, `Telo.Url`, a need-type resource — declares a `requires: telo:` floor on the same change.

1. **Need surface.** This step covers:
   - `Telo.Url` and `Telo.NeedType`;
   - the `needs:` block and its declarations, and field reads;
   - reference consumption, with the constraints handed to the consumer and the SDK's refusal constructor;
   - self-supplied fulfilments, bubbling, and both supply forms at an import;
   - per-instance fulfilments and the static refusals.

   Tests:
   - an application supplying an imported library's need with literals runs and asserts the values;
   - a consumer in the same module references an inline self-supplied fulfilment;
   - a fixture consumer refuses a supplied version outside the need's range;
   - a `Telo.Url` written as text and as an object reads the same members.
2. **Environment and report.** Derived and bound env names, decoding, precedence, `ERR_NEED_UNMET` and `ERR_NEED_PARTIALLY_SUPPLIED` at load, `telo needs report` with `-o json`, and `App.Instance`'s `needs:`. Pinned by manifest tests that set env, and by CLI run tests for the report.
3. **Kernel-declared types.** The three types, the host values, secret derivation, directory creation and the orphan refusal. Tests set the host values themselves.
4. **Runners.** Host values on the docker, k8s and local-process backends: the seed retained with the launch, a volume per session that outlives suspension, the public URL template on routed k8s sessions, and removal on deletion and at boot.
5. **PostgreSQL.** This step covers:
   - `Postgres.DatabaseAccess`;
   - `Postgres.Connection.access` beside the deprecated `connectionString`, with its verification and its two resource rules;
   - every in-repo manifest that wrote `connectionString` moved to `access`: inline at the slot when used once, its `url` in object form where the manifest composed one from separate variables.
6. **Docs.** This step covers:
   - guides for declaring a need, writing a need type and a kind that consumes and verifies it, providing needs as an operator, and testing an application with needs;
   - the need-type naming convention in the style guide;
   - the docs of `app`, `postgres` and every module that gains a need type;
   - the runner docs for the host values;
   - the authoring-agent primer, and the root and package guides.

The Rust kernel refuses a module declaring `needs:` with `ERR_UNSUPPORTED_MANIFEST_FEATURE`. Fulfilment is env reads and local derivation, so supporting it needs no network client and is an ordinary parity slice.

## Verify

- An application importing a library that needs PostgreSQL, with no `needs:` of its own, refuses `telo run` with `ERR_NEED_UNMET` naming `TELO_NEED_ORDERS__DATABASE_ACCESS__URL` before any resource initializes. With that variable set it boots, and `telo needs report` lists exactly that one entry with that name. Neither run opens a network connection before the first resource initializes.
- A root binding `env: { url: DATABASE_URL }` for the forwarded need is read from `DATABASE_URL`, and `TELO_NEED_ORDERS__DATABASE_ACCESS__URL` is then ignored. A root `env:` binding one of two required fields is refused at `telo check`.
- `telo check` offline refuses each of these:
  - a read of a field the type does not declare;
  - `Postgres.Connection.access` referencing a need of another kind;
  - a self-supplied fulfilment missing a field;
  - a library declaring `resources: { db: { kind: Postgres.DatabaseAccess } }`;
  - a versionless need forwarded to a versioned one;
  - two needs whose derived names collide.
- A self-supplied `url` in object form with a password containing `@` and `/` authenticates. A log line reading `resources.databaseAccess.url.host` is not redacted, and one reading the URL's text is.
- A manifest written against today's `postgres`, passing a `string` variable to `connectionString`, validates and runs unchanged after the upgrade, with one deprecation warning naming `access`. Writing both fields, or neither, is refused at `telo check` and at creation.
- A literal `url: "not a url"` is `URL_INVALID` at `telo check`. An env value that does not parse is `ERR_URL_INVALID` naming the variable, not the value.
- A manifest binding `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME` opens a connection through one inline `Postgres.DatabaseAccess`, and `telo needs report` on it lists nothing.
- With `DATABASE_URL` pointing at PostgreSQL 14, an application needing `>=15.0.0` is refused at the connection's init with `ERR_NEED_UNMET`, naming `DATABASE_URL`, 14 and the range. A server without `pgvector` refuses a need listing it. An unreachable address fails as a connection error, never as `ERR_NEED_UNMET`.
- Two connections referencing one need open one database; an isolated library imported twice reads two derived names. The studio's reference picker offers the need at `access` with no kind-specific code.
- With `TELO_HOST_SECRET_SEED` set, a `Telo.GeneratedSecret` reads the same value across restarts and differs between two needs. With the seed unset, the need is `ERR_NEED_UNMET` naming `TELO_NEED_<PATH>__VALUE`.
- With `TELO_HOST_STATE_DIR` set, a `Telo.DurableDirectory` keeps a file across restarts. After renaming its import alias, the next run is refused with `ERR_NEED_DIRECTORY_ORPHANED` naming both paths, and boots on the same file after the directory is moved.
- On a routed k8s session, a `Telo.PublicUrl` on port `http` reads the session's address for that port, and a watch-session edit adding one boots with the pod unchanged. No fulfilled value or seed appears in the pod spec.
- A suspended and resumed session, and a restarted pod, return the same generated secret and the same directory contents. A deleted session leaves no volume.
- An integration test supplying a self-supplied `Postgres.DatabaseAccess` over the suite's `DB_*` variables to an `App.Instance` passes against the suite's database.
- The Rust `telo` binary on a module declaring `needs:` exits with `ERR_UNSUPPORTED_MANIFEST_FEATURE` naming the block.

## Worked example

One library needs a PostgreSQL database. The same application then runs locally from one variable, under a name its author chooses, with no env at all, on a runner session with host-answered needs, behind an operator who provisions per stage, and in an integration test. The library never changes. Imports are abbreviated to the ones each part is about.

### The need type

The `postgres` module declares what a database hands over and what a request may ask for:

```yaml
kind: Telo.NeedType
metadata: { name: DatabaseAccess }
version: semver
features: [pgvector, postgis]
fields:
  url: { type: string, x-telo-type: Telo.Url, x-telo-sensitive: true }
```

`Postgres.Connection` consumes it through a reference slot:

```yaml
    access:
      x-telo-ref: { kind: Self.DatabaseAccess, use: dependency }
```

The controller receives `url` together with the need's `version` range and `features`. When the connection first proves itself at init, it reads `server_version` and the installed extensions on that same connection and refuses with `ERR_NEED_UNMET` on a mismatch. No other connection is opened for the check.

### The library and the application

The library declares the need and consumes it. It names no address and no variable.

```yaml
kind: Telo.Library
metadata: { name: Orders, version: 1.0.0 }
requires: { telo: ">=0.120.0" }
imports:
  Postgres: oci://ghcr.io/telorun/postgres@0.30.0
needs:
  databaseAccess:
    kind: Postgres.DatabaseAccess
    version: ">=15.0.0"
    features: [pgvector]
---
kind: Postgres.Connection
metadata: { name: db }
access: !ref databaseAccess
```

An application that only uses the library writes nothing about the database:

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.0.0 }
imports:
  Orders: ./orders
```

`telo needs report ./shop -o json`:

```json
{
  "reportVersion": 1,
  "needs": [
    {
      "path": "Orders.databaseAccess",
      "declaredBy": "./orders",
      "type": { "module": "oci://ghcr.io/telorun/postgres", "name": "DatabaseAccess" },
      "version": ">=15.0.0",
      "features": ["pgvector"],
      "parameters": {},
      "optional": false,
      "fields": {
        "url": {
          "env": "TELO_NEED_ORDERS__DATABASE_ACCESS__URL",
          "envSource": "derived",
          "required": true,
          "sensitive": true
        }
      }
    }
  ]
}
```

Run locally:

```
TELO_NEED_ORDERS__DATABASE_ACCESS__URL=postgres://app:secret@localhost:5432/orders telo run ./shop
```

- Without the variable, the run is refused before any resource initializes: `ERR_NEED_UNMET` naming `Orders.databaseAccess`, `Postgres.DatabaseAccess`, `./orders` and `TELO_NEED_ORDERS__DATABASE_ACCESS__URL`.
- If the variable names a PostgreSQL 14, or a server without pgvector, `Orders.db` refuses at its init with `ERR_NEED_UNMET` naming the variable, the required range and the actual version.

### Choosing the env name

The author gives the need a conventional name by declaring a root need of the same type and forwarding it:

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.1.0 }
requires: { telo: ">=0.120.0" }
imports:
  Postgres: oci://ghcr.io/telorun/postgres@0.30.0
  Orders:
    source: ./orders
    needs:
      databaseAccess: !ref databaseAccess
needs:
  databaseAccess:
    kind: Postgres.DatabaseAccess
    version: ">=15.0.0"
    features: [pgvector]
    env: { url: DATABASE_URL }
```

- The report now lists one entry, `databaseAccess`, with `env: DATABASE_URL` and `envSource: bound`.
- `TELO_NEED_ORDERS__DATABASE_ACCESS__URL` is no longer read, and nothing has to be migrated, since nothing was stored.
- Forwarding a need with a narrower range than the library's, such as `>=14.0.0`, is `NEED_FORWARD_INCOMPATIBLE` at `telo check`.

### Supplying it with no env

An author who wants no env for it supplies the fields at the import, and the need leaves the report:

```yaml
imports:
  Orders:
    source: ./orders
    needs:
      databaseAccess:
        url:
          scheme: postgres
          host: !cel "variables.dbHost"
          port: !cel "variables.dbPort"
          user: !cel "variables.dbUser"
          password: !cel "secrets.dbPassword"
          path: !interpolate "/${{ variables.dbName }}"
```

A password holding `@` or `/` is escaped by the type, and `telo needs report ./shop` lists nothing.

### A secret, a directory and the public address

The three kernel-declared types are declared like any other need:

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.2.0 }
requires: { telo: ">=0.120.0" }
imports:
  Http: oci://ghcr.io/telorun/http-server@0.29.0
  Fs: oci://ghcr.io/telorun/fs@0.9.4
ports:
  http: { env: PORT, default: 8080 }
needs:
  sessionKey:
    kind: Telo.GeneratedSecret
    parameters: { bytes: 32 }
  uploads:
    kind: Telo.DurableDirectory
    parameters: { size: 5Gi, access: single-writer }
  publicUrl:
    kind: Telo.PublicUrl
    parameters: { port: http }
    env: { url: PUBLIC_URL }
targets:
  - !ref server
---
kind: Fs.File
metadata: { name: uploadFile }
cwd: !cel "resources.uploads.path"
---
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
baseUrl: !cel "string(resources.publicUrl.url)"
mounts:
  - path: /
    mount: !ref api
```

The router mounted as `api`, and what reads `uploadFile` and `sessionKey`, are omitted.

- **On a routed k8s runner session**, all three are answered with no configuration:
  - `sessionKey` is derived from the session's `TELO_HOST_SECRET_SEED` and the path `sessionKey`;
  - `uploads` is `<TELO_HOST_STATE_DIR>/needs/uploads` on the session's volume;
  - `publicUrl` is `TELO_HOST_PUBLIC_URL_TEMPLATE` with `{port}` replaced by 8080, such as `https://8080-s7k2m9.run.example.com`.

  A suspend and resume, or a restarted pod, returns the same key and the same files.
- **On a docker runner session**, `sessionKey` and `uploads` are answered the same way. `publicUrl` has no host value there, so the session's env must set `PUBLIC_URL`.
- **Under `telo run`**, the run is refused with `ERR_NEED_UNMET` naming `TELO_NEED_SESSION_KEY__VALUE`, `TELO_NEED_UPLOADS__PATH` and `PUBLIC_URL`. A developer sets those, or sets the two host values once and gets a stable key and directory:

```
TELO_HOST_SECRET_SEED=<32 bytes, base64url> TELO_HOST_STATE_DIR=./data PUBLIC_URL=http://localhost:8080 telo run ./shop
```

- Renaming `uploads` to `files` refuses the next run with `ERR_NEED_DIRECTORY_ORPHANED`, naming `./data/needs/uploads` and `./data/needs/files`. Moving the directory is the repair. `sessionKey` renamed reads a new value, so a key that must survive a rename is bound by `env:` and provided by the operator.

### An operator providing it

An operator deploying `Shop` 1.0.0 to a cluster reads the report and provisions each entry it understands. For `Postgres.DatabaseAccess` it creates a database and role on its CloudNativePG cluster, writes the connection URL to a Secret, and maps it to the entry's env name:

```yaml
env:
  - name: TELO_NEED_ORDERS__DATABASE_ACCESS__URL
    valueFrom: { secretKeyRef: { name: shop-orders-db, key: url } }
```

- The value never appears in the pod spec, and the workload never learns how it was provisioned.
- When the operator rotates the password, it updates the Secret and restarts the pod, as for any env value.
- An entry of a type the operator does not understand is reported by the operator before it starts anything. If the operator starts the workload anyway, the kernel's `ERR_NEED_UNMET` names the missing variable.

### A test against the suite's database

The integration suite's existing `DB_*` variables feed the started application's need field by field. The application is `Shop` 1.1.0, the version that declares `databaseAccess` itself.

```yaml
kind: Telo.Application
metadata: { name: ShopOrdersTest, version: 1.0.0 }
requires: { telo: ">=0.120.0" }
imports:
  App: ../../../modules/app
  Run: ../../../modules/run
  HttpClient: ../../../modules/http-client
  Assert: ../../../modules/assert
variables:
  dbHost: { env: DB_HOST, type: string }
  dbPort: { env: DB_PORT, type: integer }
  dbUser: { env: DB_USER, type: string }
  dbName: { env: DB_NAME, type: string }
secrets:
  dbPassword: { env: DB_PASSWORD, type: string }
targets:
  - !ref test
---
kind: Run.Sequence
metadata: { name: test }
with:
  - kind: App.Instance
    metadata: { name: shop }
    source: ../../telo.yaml
    ports: { http: 8091 }
    needs:
      databaseAccess:
        url:
          scheme: postgres
          host: !cel "variables.dbHost"
          port: !cel "variables.dbPort"
          user: !cel "variables.dbUser"
          password: !cel "secrets.dbPassword"
          path: !interpolate "/${{ variables.dbName }}"
targets:
  - !ref shop
steps:
  - name: create
    invoke:
      kind: HttpClient.Request
      url: http://127.0.0.1:8091/orders
      method: POST
    inputs:
      body: { sku: !interpolate "widget-${{ uuidv4() }}", quantity: 2 }
  - name: verify
    invoke: { kind: Assert.Equals }
    inputs:
      actual: !cel "steps.create.result.status"
      expected: 201
```

- The file lives under `tests/integration/`, because it needs a live database.
- The child's connection verifies the suite's server against `>=15.0.0` and pgvector, so a suite database without the extension fails the test at the child's init with `ERR_NEED_UNMET`.
- Tests share the one database, so each identifies the rows it writes (`uuidv4()`).
- A test that supplies the URL as one literal, against a fixture need type with a fixture consumer, runs in the root suite with nothing running.

### Running it

```
telo needs report ./shop
DATABASE_URL=postgres://app:secret@localhost:5432/orders telo run ./shop
```

- `report` prints the one entry, `databaseAccess`, with `DATABASE_URL`, `bound`, `required` and `sensitive`, and no value.
- `run` reads `DATABASE_URL` at load, delivers it to `Orders.db`, and contacts nothing before the connection opens.
