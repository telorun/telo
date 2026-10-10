# Host needs

A module declares what it needs from whatever runs it — a backing service, host software, a co-located process, durable storage, its public address, a generated secret — and the host fulfils it or refuses to boot.

## Before

- A backing service is a hand-filled `variables:` / `secrets:` entry. Nothing says "this is a PostgreSQL 15 with pgvector", so no host can supply it.
- A module that spawns `ffmpeg` or opens a system library it does not ship fails at first use, on whichever host lacks it.
- A directory that must survive a restart, the application's own public URL and a key that must be generated once are ordinary values the operator has to know to provide.
- A test that needs a database gets its connection from env the developer set up by hand, and nothing about an application started with `App.Instance` is checked statically.

## After

### Need types

- `kind: Telo.NeedType` registers a kind `<Module>.<Name>`, exported through `exports.kinds` and gated like any other. Any library may export one, so the vocabulary is open by publication and Telo owns no list.
- A type owns: `fields` (JSON Schema property map of what a fulfilment hands over; a field may be `x-telo-sensitive: true` and carry an `x-telo-type`), `parameters` (schema of what a need may ask), `features` (the closed list of feature names for this type), and `version: semver` when fulfilments of the type are versioned.
- A type's identity is its declaring module's location plus its name, independent of the module's version. Types evolve additively.
- A need type is named for what its fulfilment hands over: `<Thing>Access` when that is the address and credentials of something outside the application, `<Thing>` being the exact unit the credentials are scoped to (`Postgres.DatabaseAccess`, `Redis.ServerAccess`, `S3.BucketAccess`, `OpenAI.ApiAccess`); the bare noun when the fulfilment is the thing itself on the host (`Ffmpeg.Executable`). The name of the object itself stays free for a kind that creates or owns it.
- Three types are declared by the kernel: `Telo.DurableDirectory` (parameters `size`, `access: single-writer | shared`; field `path`, a `Telo.HostPath`), `Telo.PublicUrl` (parameter `port`, a key of the root's `ports:`; field `url`, a `Telo.Url`), `Telo.GeneratedSecret` (parameter `bytes`; field `value`). The kernel declares them and fulfils none; a supplier answers them like any other type.

### `Telo.Url`

- A new value type for a URL that may carry credentials. It is written as its text (`postgres://app:…@db.internal:5432/orders`) or as an object — `scheme`, `host`, `port`, `user`, `password`, `path`, `query` — whose members the type escapes, so nobody assembles a URL out of a generated password.
- In CEL it is a nominal type, not a `string`: its members are read by name, and `string(url)` is its text. The `password` member is sensitive on its own, so reading `host` is never redacted and reading `password` or the whole text always is.
- An env value supplying a `Telo.Url` is its text. Text that does not parse is refused naming the variable, never printing the value.

### Declaring a need

- `needs:` is a block on a `Telo.Application` or `Telo.Library` doc, keyed by a camelCase name. An entry has `kind: <Alias>.<Name>`, and optionally `version` (a range in the `requires:` comparator grammar, legal only when the type is versioned), `features` (a subset of the type's list), `parameters` (literals) and `optional: true`.
- An entry is a declaration of that kind in the module's scope, as a Library `resources:` entry is. It shares the module's one namespace (`DUPLICATE_RESOURCE_NAME`) and is named by `!ref <name>`.
- The two blocks stay separate contracts: a `resources:` entry is a live instance its importer must hand over, a `needs:` entry is a value any level up to the host may supply. A Library `resources:` entry whose kind is a need type is `RESOURCE_INPUT_NEED_TYPE` (`ERR_RESOURCE_INPUT_NEED_TYPE`), with the repair "declare it under `needs:`".
- A need declares no fields. One field is read as `resources.<name>.<field>`, typed from the need type and closed to its fields, readable at startup in `!cel` and in every `!interpolate` hole. A whole fulfilment is always handed over by `!ref`, never as a CEL value.
- The consumed set is every field read through `resources.<name>.<field>`, or every field of the type when any `!ref` names the need. Only the consumed set is delivered.
- A field keeps its type and its sensitivity: a sensitive field is redacted wherever it is read, as a `secrets.` value is.
- An optional need is nullable and reading it unguarded is `CEL_NULLABLE_ACCESS`.
- A library declares `Telo.PublicUrl` without `port`; its importer binds the port in the import entry.

### A kind that consumes a need

- A kind that takes a whole fulfilment declares an ordinary reference slot: `x-telo-ref: { kind: Self.<NeedType>, use: dependency }`. The controller resolves it like any reference and receives the fulfilment's fields. The type and its consumer are tied by the same link, and the same check, as any other slot in the module.
- The slot accepts any declaration of the need-type kind: a need, a lease or a self-supplied fulfilment. That is the only shape it accepts, so values enter by becoming such a declaration.
- A need of another kind at the slot is `REFERENCE_KIND_MISMATCH`; a non-reference is `INVALID_REFERENCE_FORM`; a computed value is `REF_SLOT_COMPUTED`.
- A `!ref` to an `optional: true` need at a kind's reference slot is `NEED_OPTIONAL_REFERENCED` (`ERR_NEED_OPTIONAL_REFERENCED`). An optional need is consumed by guarded field reads, or forwarded to a need that is itself optional.
- `Postgres.Connection` takes `database`, a reference to `Self.DatabaseAccess`, and `connectionString` is removed: where the database is has one home. `Postgres.DatabaseAccess` has one field, `url`, a sensitive `Telo.Url`.
- Every stdlib module with a backing service follows the same pattern: the module that opens the connection exports the need type and a kind whose slot references it.
- A slot that holds one scalar — a file path, an API key — keeps taking one field by CEL.

### A fulfilment held by the module

A resource declared with `kind: <need type>` is a fulfilment the module holds. It satisfies the same reference slot and is read the same way as a need — `resources.<name>.<field>`, at startup — and it states one of two sources.

- **Self-supplied** — it carries `fields:`, the same construct as a `Supply.Offer`'s: it must yield every required field of the type (`NEED_SLOT_MISMATCH`), and a key the type does not declare is `NEED_FIELD_UNDECLARED`. Each value is a literal or startup `!cel` / `!interpolate` over `variables`, `secrets` and other resources' startup-readable readings; observed state stays refused there. A `Telo.Url` field is assembled in its object form, each member a literal or CEL.
- A self-supplied fulfilment never reaches a supplier: it has no binding, no scope and no entry in the needs report. It is an ordinary configured resource in the init order.
- **Lease** — it carries no `fields:`, and optionally the same `version` / `features` / `parameters` as a need entry, all literals. The supplier is asked, and the fulfilment lasts as long as the context declaring the lease.
- Declared in a `Run.Sequence`'s `with:`, a lease's lifetime is the sequence — which is how a test gets a database that exists only while the test runs. Declared as a module-level document, it lasts as long as the module instance and is released at teardown, never retained.
- `fields:` beside `version`, `features` or `parameters` is `NEED_FULFILMENT_SOURCE_CONFLICT` (`ERR_NEED_FULFILMENT_SOURCE_CONFLICT`).
- A need-type kind has no capability a `targets:` entry accepts: nothing runs a lease, and listing one there is the existing reference-kind refusal.

### Bubbling, forwarding and bindings

- A need nobody supplies bubbles up the import closure to the root. An application author writes nothing for a need they neither use nor override.
- An import entry's `needs:` map supplies a library's need — whole, with a `!ref` to any declaration of that kind in the importer (a need, a lease or a self-supplied fulfilment), or field by field, each a literal or CEL (`url: !cel "resources.database.url"`), which is how one fulfilment feeds a need of a different type. A supplied need leaves the aggregate.
- The field-by-field map is a self-supplied fulfilment written anonymously, its kind implied by the target's declaration and its checks the same — so an importer supplies a need without importing the module that exports its type.
- A binding belongs to a module instance. An `isolated` library gets one binding per import; a `shared` library gets one for the whole application, and what its importers forward joins the existing rule that every import of a shared library must agree.
- Two libraries, or two started applications, needing the same type get separate bindings unless one need or one lease is supplied to both.

### Started applications

- `x-telo-application-source: { variables?, secrets?, ports?, needs?, supplier? }` on a literal string property of a kind's schema says the value is the location of an application the resource starts. Each key is a JSON Pointer to the sibling that supplies that part of the started application. The annotated field takes no computed value, so it carries no `x-telo-eval`.
- The loader follows the field as a start edge. Each resolved source is loaded and analysed once, however many resources start it, and is part of the closure `telo install` and `telo changed` see.
- The keys of the `variables`, `secrets`, `ports` and `needs` maps must be declared by the started application, and their values are type-checked against its declarations. A `needs` value takes the same two forms as at an import.
- What the `needs` map leaves unsupplied joins the starter's own report, pathed under the starting resource's name, exactly as an import's does. When the `supplier` slot is written — a `!ref` to a `Telo.NeedSupplier` — those needs go to that supplier instead and leave the starter's report.
- `App.Instance` annotates `source` with all five pointers and gains `needs:` and `supplier:`.
- `Test.Suite` is not followed: its children are chosen by globs and command-line arguments, so the set is not manifest content. Each discovered test is a root with its own report, `telo needs` on the suite lists only the suite's own needs, and the suite gains the same `supplier:` slot.
- `Assert.Manifest` is not annotated: its target is expected to fail, and following it would put the expected errors into the parent's check.

### Scope and lifetime

Every binding has a scope, and the scope fixes who may end it.

- `application` — a need declared in a `needs:` block. Retained: workload exit, restart, reload and suspension never release it. Only the host authority does — session deletion on a runner, `telo needs release <path>` locally. Retention covers the binding's identity and data; whether its compute runs while nothing is attached is the supplier's choice.
- `resource` — a lease. Acquired by the kernel when the context declaring it opens — at load for a module-level one, at each run of the scope for one in a `with:` — before any resource of that context initializes, so every consumer sees its fields at its own init and no resource's init or run performs supplier I/O. Released when that context tears down, renewed by the kernel while it lives, and reaped by the supplier when it expires — which is what cleans up after a test that crashed and never reverted anything.
- Every lease of one context is acquired in one message, under the opening invocation's cancellation and deadline (the start deadline at load). An unmet or timed-out lease is `ERR_NEED_UNMET` before any resource of that context initializes, and the leases that message already granted are released.

### Renames

A retained binding is keyed by its path, and a path has several authors — the need's name, each importer's alias, a starting resource's name, a library's lifecycle. Changing any of them changes the key.

- `needMoves:` on a `Telo.Application` or `Telo.Library` doc is a list of `{ from, to }` binding paths relative to the declaring module instance. `to` must be a declared path (`NEED_MOVE_TARGET_UNDECLARED`), `from` must not be (`NEED_MOVE_SOURCE_DECLARED`), and chains are flattened.
- Each report entry carries `formerPaths`. At resolve, a binding held at a former path with nothing held at the current one is re-keyed atomically when the need type matches. Held at both is `ERR_NEED_BINDING_CONFLICT`; a different type is unmet, with that reason.
- An orphan is a held retained binding at no declared or former path. When the same resolve would create a fresh binding of the same need type, the run is refused with `ERR_NEED_BINDING_ORPHANED` before any resource initializes and with nothing provisioned; the message names both paths and the two repairs — a `needMoves` entry, or `telo needs release <old path>`. Otherwise it is a `NEED_BINDING_ORPHANED` warning. An orphan is never released automatically.
- An editor rename of a need, an import alias or a resource diffs the report before and after and adds a `needMoves` entry for each changed path in the same edit.

### Supplying a need from the environment

- A root Application's `needs:` entry may carry `env: { <field>: <NAME> }`. That is the only way a need is read from the environment: no name is derived, and a field the root did not bind has no env name.
- A set bound name wins and the supplier is not asked for that need. One manifest therefore runs both ways, the operator choosing at start. When any bound field of a need is set, every consumed required field must be (`ERR_NEED_PARTIALLY_SUPPLIED`).
- A library cannot bind env (`LIBRARY_ENV_KEY_REJECTED`). A root makes a library's need env-suppliable by declaring a need of its own with `env:` and forwarding it at the import.
- An `env:` key naming no field of the type is `NEED_FIELD_UNDECLARED`. A bound name equal to another need field's, or to a `variables` / `secrets` / `ports` env name, is `NEED_ENV_NAME_COLLISION`.
- A bound name reads `undefined` from the process environment inside the workload, as a bound variable's does.

### The needs report

- `telo needs <path>` prints, with nothing booted, one entry per unmet binding across the whole tree, statically followed started applications included: its path, `formerPaths`, `scope`, declaring module, type, version range, features, parameters, whether it is optional, the consumed fields, which are sensitive, and each field's bound env name when it has one. It carries no values.
- `telo needs --held <path>` lists the bindings the local host holds for the application without values: bound, pending, external and orphaned, each with the offer that made it, and for a binding under migration its current, successor and superseded fulfilments.
- The document is versioned and extensible. It is the one input to fulfilment on every host — a runner and the studio read the bound env names from it — and the document a later CPU/memory estimate joins.

### Suppliers

- Whoever starts an application is its supplier. A root's starter is the CLI or a runner; a started application's is the resource that started it, which answers what its `needs:` supplies and passes the rest to its own supplier, or to the one its `supplier:` slot names.
- That relay belongs to the mechanism that starts a child application, not to any kind: every kind starting one through it relays, so a supplier given to a suite reaches every test it runs.
- `Telo.NeedSupplier` is a kernel built-in abstract: a resource of a kind extending it answers the supplier contract. It is what a `supplier:` slot accepts and what a host runs.
- The supplier contract is normative with a closed message set, the same at every level:
  - prepare — the report in; per entry an answer of prepared, nothing to prepare, or unmatched (with a reason). It fetches what a fulfilment needs on disk and is idempotent; it creates no binding, mints nothing and starts nothing;
  - resolve — the report in; per `application` binding an answer of bound (field values, their `generation`, an optional `refreshAfter`, and the fulfilment's `footprint` when it has one), pending (polled under the start deadline) or unmet (with a reason); per `resource` binding only available or unmet, with nothing provisioned; plus the orphans it holds;
  - refresh — the held bindings and the generation the kernel has of each in; the fields and generation of each one that changed out;
  - acquire, renew and release — for leases, sent when a context opens (every lease of it in one message), while it lives, and when it tears down;
  - bind, migrate and release-scope — the host authority's: setting a retained binding's fields at a path, moving a retained binding to another fulfilment, and ending every retained binding of a scope. A workload's own token can send none of them.
- The spec sits beside the controller protocol's as `kernel/specs/need-supplier.md`, its message data and generation under `sdk/need-supplier/`, and `pnpm run check:need-supplier` checks the two against each other in both directions.
- A kernel carries the contract's client, `Telo.NeedType` and `Telo.NeedSupplier` — and no vocabulary for how a need is fulfilled.

### Offers and catalogs

Fulfilment is ordinary modules, so a new way to fulfil a need ships without a telo release.

- The `supply` module exports `Supply.Offer` and `Supply.Catalog`.
- `Supply.Offer` states how a type is fulfilled: `provides: <Alias>.<Name>`, `version`, `features`, a platform `selector` (`os` / `arch` / `libc`), an optional `footprint` (`cpu`, `memory`), optional `prepare:`, `acquire:`, `rotate:`, `freeze:` and `release:` step bodies in the shared step grammar, and `fields:`.
  - `provides` is declared with `x-telo-need-type: { fulfilment, version, features }` — the value names a need type, and each key is a JSON Pointer to the sibling holding that part. `fields:` must yield every field of the named type (`NEED_SLOT_MISMATCH`), `version` and `features` must be admitted by it (`NEED_PARAMETERS_INVALID`), and a name resolving to no need type is `NEED_TYPE_UNRESOLVED`.
  - `prepare:` fetches what the fulfilment needs on disk, once per host and independent of any binding. Its CEL scope holds the request's `parameters`, `features` and version and the platform selector, and no `binding`, so reading `binding.*` there is the existing unknown-name refusal at `telo check`. Its results are read as `prepared.<step>.result` in `acquire:` and `fields:`.
  - `fields:` is CEL over `binding.id` and `binding.secret` (generated per binding and stable for its life), `binding.parameters`, `binding.features`, `prepared.<name>.result` and `steps.<name>.result` of the `acquire:` body, typed from each invoked kind's `outputType`.
  - An offer with neither `prepare:` nor `acquire:` is static.
  - `rotate:` with `rotateEvery:` (a `Telo.Duration`) is for credentials that expire. The catalog runs it after `acquire:` and again each period; `fields:` reads its results as `rotated.<step>.result`, and each run yields a new generation of the binding.
  - `freeze:` makes the fulfilment read-only. It is what lets a binding of this offer be the source of a `freeze` migration.
  - `release:` and `freeze:` read `binding` and the bound fields only.
  - Any body may be dispatched more than once for one binding, so everything it creates is named from `binding.id`.
- `Supply.Transfer` moves the contents of one fulfilment of a type into another: `moves: <Alias>.<Name>` (declared with `x-telo-need-type`), and `copy:` and `finalize:` step bodies whose CEL scope holds `from` and `to`, each typed as that type's fields. It is declared per need type, never per pair of offers, so one transfer covers every source and target of the type, an external binding included. `copy:` is bulk and repeatable and runs while the source serves; `finalize:` runs once at cutover.
- `Supply.Catalog` extends `Telo.NeedSupplier`. It takes `offers:` and `transfers:` (lists of `!ref`) and a required `store:` (a `KvStore.Store`), and owns matching, pending answers while an `acquire:` runs, retained bindings persisted by conditional write, re-keying, rotation, migration, and lease expiry and reaping. Asked to resolve or acquire something unprepared, it prepares it first, so a run with no prior install behaves the same.
  - The order of `offers:` is preference: the first offer matching a need's type, version, features and platform answers it. A retained binding records the offer that made it and stays with it, so reordering `offers:` never moves an existing fulfilment; only a migration does.
  - An `acquire:` that has not finished by the start deadline keeps running and its binding stays pending in the store. That run is refused with `ERR_NEED_UNMET`, the reason saying it is still provisioning, and the next resolve picks up the same binding rather than starting a second one.
- What an `acquire:` body invokes lives in its own module:
  - `supply-container` — `ContainerSupply.Run` (`image`, named `ports`, `env`, and `ready` as either `port: <name>` accepting a connection or a `command:` exiting zero inside the container; returns `host` and `ports`), `ContainerSupply.Remove`, and `ContainerSupply.Pull` (`image`), which a container offer invokes in `prepare:`.
  - `supply-download` — `DownloadSupply.Fetch`, with entries in the module `sources:` entry shape, returning each as a `Telo.HostPath`. A download-fulfilled offer invokes it in `prepare:` and has no `acquire:`.
  - `supply-local` — ready-made offers for the three kernel-declared types, answered under `.telo/needs/`, with `Telo.PublicUrl` as the local address of the port.
- A database per binding on a managed server is an offer whose `acquire:` runs SQL steps; it needs no host code.
- A third party fulfils a type the same way: a cloud vendor publishes a module importing the type's module and `supply`, exporting an offer for its managed service and the kinds its bodies invoke, and an operator lists it in `offers:`, configuring account and region through the import's `variables` / `secrets`.
- An offer and a transfer are exported through `exports.resources`, so the hub finds them as instances of `Supply.Offer` and `Supply.Transfer`.
- All four modules are MIT, each with `license: MIT` and its own `LICENSE`.

### Fulfilment

- `telo run` resolves once per load, before any resource initializes, for every binding the environment has not supplied.
- The workload names needs only — never an offer, an image or an address.
- Locally the CLI hosts the supplier, outside the workload's module scope: `--supplier <path>` or `TELO_SUPPLIER` names a library exporting one `Telo.NeedSupplier` instance. With neither set it hosts a catalog of the `supply-local` offers, storing its bindings under `.telo/needs/`.
- `telo install` sends prepare, so everything a need's fulfilment must fetch is on disk and a later run needs no network; it binds nothing. It prepares needs and leases alike, for the platform selector it materializes module layers for, against the supplier `telo run` would use. Needs handed to an in-manifest `supplier:` slot are outside the report and are not prepared.
- The CLI-hosted catalog keeps prepared material under `.telo/needs/prepared/`, content-addressed by its pinned digest and separate from binding records.
- A runner hosts the operator's supplier library and fronts it per session, given to the workload as `TELO_SUPPLIER_URL` and a token minted per session and application in `TELO_SUPPLIER_TOKEN`. It answers within the session's quota. Deleting the session releases its bindings; suspending it does not, and the workload's own token cannot.
- A retained binding is keyed by session, application and need path, idempotent and persisted by the host: a reload, a resume or another runner replica returns the same secret and the same directory.
- A container-fulfilled need runs as a separate workload reachable from the session, never as a container added to the application's pod.
- Fulfilled values never enter a pod spec or a container's env block.

### Binding an existing service

An operator points a need at something that already exists — their own cloud database — with no change to the application and no offer.

- `telo needs bind <path> --field <name>=<value>`, or `--field-from-env <name>=<NAME>` to keep a value out of the shell history, sends bind. On a runner the same bindings are given at session creation, keyed by need path, read from the needs report.
- The fields are checked against the need type at bind (`NEED_SLOT_MISMATCH`, `NEED_FIELD_UNDECLARED`) and stored as a retained binding marked external.
- Resolve returns an external binding as bound and consults no offer. A set `env:` name still wins over it.
- Releasing an external binding forgets it and runs no `release:` body, so the operator's own service is never touched.
- `needMoves` and the orphan rules apply to it unchanged. Binding the same path again replaces its fields as a new generation.

### Fields that change

A binding's fields may change while the application runs — a rotated credential, a manual re-bind, a migration's cutover.

- Each bound answer carries a `generation`, and `refreshAfter` when the supplier knows when to ask again. The kernel sends refresh then, and at a fixed interval otherwise.
- When a generation changed, the kernel re-creates the resources that consume that need — by `!ref` or by a field read — through the same reconcile a reload uses, and touches nothing else.
- A need supplied by env never refreshes: its value is the process's own.

### Migrating a binding

A retained binding is moved to another offer, or to an external binding, while the application keeps running.

- `telo needs migrate <path> --to <offer>` or `--to-external --field <name>=<value>`, with optional `--transfer` and `--mode rolling | freeze` (default `freeze` with `--transfer`), sends migrate. A runner exposes the same action on a session.
- The supplier acquires a successor fulfilment for the same path with its own `binding.id`, while the current one keeps serving.
- With `--transfer` the catalog runs the `Supply.Transfer` for the need's type: `copy:` now, `finalize:` at cutover. With none listed for the type the migration is refused with `ERR_NEED_TRANSFER_UNAVAILABLE`. Without `--transfer` the successor starts empty, or holds what the operator moved themselves.
- Cutover is one conditional write that makes the successor current as a new generation. Each replica adopts it at its next refresh or restart, so a runner rolls them one at a time.
- `rolling` cuts over with no pause. Some replicas write to the old fulfilment while others write to the new one, so it loses nothing only when the transfer keeps the two in sync or the contents are re-derivable.
- `freeze` runs the source offer's `freeze:`, then `finalize:`, then cuts over: nothing is lost, and writes fail from the freeze until each replica adopts. A source whose offer has no `freeze:`, or an external one, is refused with `ERR_NEED_FREEZE_UNSUPPORTED`.
- The old fulfilment is kept as superseded and is never released automatically. `telo needs release <path> --superseded` ends it; before cutover `telo needs migrate <path> --abort` releases the successor instead.
- Every phase is persisted. Running the same command again resumes it; a different target while one is in progress is `ERR_NEED_MIGRATION_IN_PROGRESS`.

### Refusals

| Code | When |
|---|---|
| `NEED_TYPE_UNRESOLVED` | a `needs:` entry's `kind:`, or an `x-telo-need-type` field, naming no exported need type |
| `NEED_PARAMETERS_INVALID` | parameters, features or a version range the type does not admit; `Telo.PublicUrl` naming no `ports:` key |
| `NEED_FIELD_UNDECLARED` | a key of a field-by-field supply map, of a need-type resource's `fields:` or of an `env:` map that the type does not declare |
| `NEED_SLOT_MISMATCH` | `fields:` — an offer's, a need-type resource's or a field-by-field supply map — not yielding every required field of the type |
| `NEED_FULFILMENT_SOURCE_CONFLICT` / `ERR_NEED_FULFILMENT_SOURCE_CONFLICT` | a need-type resource carrying `fields:` beside `version`, `features` or `parameters` |
| `RESOURCE_INPUT_NEED_TYPE` / `ERR_RESOURCE_INPUT_NEED_TYPE` | a Library `resources:` entry whose kind is a need type |
| `NEED_OPTIONAL_REFERENCED` / `ERR_NEED_OPTIONAL_REFERENCED` | a `!ref` to an optional need at a kind's reference slot |
| `NEED_UNDECLARED` | a `needs:` key at an import or at an application source that the target does not declare |
| `NEED_ENV_NAME_COLLISION` | a need field's bound env name equal to another bound name of the application |
| `APPLICATION_INPUT_UNDECLARED` | a `variables` / `secrets` / `ports` key at an application source that the target does not declare |
| `APPLICATION_SOURCE_UNRESOLVED` | an application source resolving to nothing |
| `APPLICATION_SOURCE_NOT_APPLICATION` | an application source whose target is not a `Telo.Application` |
| `APPLICATION_SOURCE_CYCLE` | an application reaching itself through start edges |
| `APPLICATION_SOURCE_ANNOTATION_INVALID` | on the definition: the annotated field also carries `x-telo-eval`, or a pointer names no property |
| `NEED_MOVE_TARGET_UNDECLARED` / `NEED_MOVE_SOURCE_DECLARED` | a `needMoves` entry whose `to` is not a declared path, or whose `from` is |
| `NEED_UNMET` / `ERR_NEED_UNMET` | a required need with no supplier answer and no env value, or a lease the supplier cannot answer when its context opens; names the need, its type, the declaring module and its bound env names |
| `ERR_NEED_PARTIALLY_SUPPLIED` | some but not all consumed required fields of a need set by env |
| `ERR_NEED_BINDING_CONFLICT` | a binding held at both a former path and the current one |
| `ERR_NEED_BINDING_ORPHANED` / `NEED_BINDING_ORPHANED` | an orphan when the resolve would create a fresh binding of its type; a warning otherwise |
| `ERR_NEED_TRANSFER_UNAVAILABLE` | a migration asking for a transfer when the supplier lists none for the need's type |
| `ERR_NEED_FREEZE_UNSUPPORTED` | a `freeze` migration whose source is external or made by an offer with no `freeze:` |
| `ERR_NEED_MIGRATION_IN_PROGRESS` | a migration to a different target while one is in progress at that path |

A field read the type does not declare is the existing `CEL_UNKNOWN_FIELD`, and a wrong kind at a consuming slot the existing `REFERENCE_KIND_MISMATCH`. The static refusals and their kernel twins get rows in the check/run agreement suite.

### Tests

- A test declares a lease in its sequence's `with:` and supplies it to the `App.Instance` it starts with `needs: { <name>: !ref <lease> }`. Each test declaring its own gets its own; an API and its worker share one by taking the same `!ref`.
- The root suite must pass with no container engine installed, so there a need is supplied field by field with literals, by a self-supplied fulfilment, or by an inline `Supply.Catalog` of static offers over the in-memory key/value store. A test whose lease only a container can answer lives under its module's `tests/integration/`.

## Constraints from work not in this plan

- **Grants.** A fulfilled field is the scope of a derived grant — a bound host is outbound access to it, a resolved executable is permission to run it, a library is permission to load it, a directory is write access. So values are delivered only to the module instance that declared the need, no controller reads them from the process environment, and an address is a `Telo.Url` whose `host` and `port` a grant reads without parsing text.
- **Compute estimate.** A co-located fulfilment consumes the application's budget and a remote one does not, which is why an offer states a `footprint`, a bound answer carries it, and the report is extensible.

## Order of work

Every module adopting new surface — `needs:`, `needMoves:`, `Telo.Url`, a need-type resource, `x-telo-need-type`, `x-telo-application-source` — declares a `requires: telo:` floor on the same change.

1. **Need surface.** `Telo.Url`; `Telo.NeedType` registering a kind; the `needs:` block and its declarations; the three kernel-declared types; reference consumption and field reads; the self-supplied fulfilment; bubbling; whole and field-by-field supply at an import; per-instance bindings; the static refusals; `ERR_NEED_UNMET` at load. Tests: an application supplying an imported library's need with literals runs and asserts the values; a consumer in the same module references an inline self-supplied fulfilment; one reading a single field receives only that; an unsupplied one fails with `ERR_NEED_UNMET`; a `Telo.Url` written as text and as an object reads the same members.
2. **Started applications.** `x-telo-application-source`, `App.Instance`'s `needs:` with literal supply, and the static input checks. Tests: a root application's own needs supplied by the test that starts it; `NEED_UNDECLARED` and `APPLICATION_INPUT_UNDECLARED` at check, with their boot twins.
3. **Report and env.** The report, `telo needs`, root `env:` bindings with their refusals, and the static half of `needMoves:`. CLI surface only, pinned by CLI run tests.
4. **Contract and catalog.** The supplier contract as spec, data and check; `Telo.NeedSupplier`; prepare; resolve before init, with pending; leases acquired at context open; refresh and the reconcile of a changed binding's consumers; the child-start relay; the `supplier:` slots; `supply` with static offers, offer preference and `rotate:`. Tests: an inline catalog over the in-memory store handed to an `App.Instance`; two instances get distinct bindings; the first of two matching offers answers; a rotated field reaches a running consumer and no other resource is re-created; a shared `!ref` gives one; a consumer's init reads a sibling lease's fields with no `targets:` entry for the lease; a lease is released when its sequence ends.
5. **CLI as host.** `--supplier`, the default catalog, `supply-local`, retention, re-keying and orphans, `telo needs release`, `telo needs --held`, prepare in `telo install`, provisioning resumed across runs, `telo needs bind`, and `telo needs migrate` with `Supply.Transfer`, both modes, abort and the superseded release.
6. **Engine-backed sources.** `supply-container` and `supply-download`, their offers carrying `prepare:`, with integration tests.
7. **Runners.** The runner-core session endpoint and token, then the docker and k8s backends hosting an operator's supplier library, with persisted bindings, lease reaping and release on session deletion; external bindings at session creation; migration as a session action, replicas rolled at cutover.
8. **PostgreSQL.** `Postgres.DatabaseAccess`; `Postgres.Connection.database` replacing `connectionString`, released as a minor with the break described; every in-repo manifest that wrote `connectionString` moved to a need, or to a self-supplied `Postgres.DatabaseAccess` — inline at the `database` slot when used once, its `url` in object form where the manifest composed one from separate variables; a static and a container offer, the container one with `freeze:`; a `Supply.Transfer` for the type; integration tests using them, one migrating a binding between two offers.
9. **Docs.** Guides for declaring a need, writing a type, writing an offer, writing a transfer, running a supplier, binding an existing service, migrating a binding, renaming a need and testing an application with needs; the need-type naming convention in the style guide; the docs of every new module and of `app`, `test` and `postgres`; the authoring-agent primer; the root and package guides.

The Rust kernel carries no supplier client, so it refuses a module declaring `needs:` or a lease with one diagnostic until it does; a need consumed by reference asks no CEL of it. The supplier contract is language-neutral data, as the controller protocol is, so a Rust application can be started and supplied by a Node one.

## Verify

- At the end of each of steps 1, 2 and 4 the root suite holds a passing test that reads a fulfilled need, on a clean checkout with nothing running.
- An application importing a library that needs PostgreSQL, with no `needs:` of its own, boots on a runner whose supplier offers it, with no connection value written anywhere; `telo needs` lists exactly that one binding.
- One manifest binding `env: { url: DATABASE_URL }` boots both ways: with the variable unset the supplier provisions; with it set the application boots against an empty catalog. With neither a matching offer nor the variable it is refused with `ERR_NEED_UNMET`, naming `DATABASE_URL`, before any resource initializes.
- `telo check` offline refuses: a read of a field the type does not declare; `Postgres.Connection.database` referencing a need of another kind (`REFERENCE_KIND_MISMATCH`); an offer missing a field (`NEED_SLOT_MISMATCH`); a mistyped need or variable name at an `App.Instance`.
- A kind written outside the repo with `x-telo-application-source` gets the same checks, and an application started by a hundred resources is analysed once.
- An offer writing `url` in object form with a generated password containing `@` and `/` yields a connection that authenticates; a log line reading `resources.database.url.host` is not redacted and one reading the URL's text is.
- Two connections referencing one need get one database; the studio's reference picker offers the need at `database` with no kind-specific code.
- An integration suite given `TELO_SUPPLIER` once runs a test whose started application has its need met by that supplier, with nothing about offers written in the test.
- A new way to fulfil a need ships as a module with no release of the telo version line, and the Rust kernel's surface holds no offer key.
- An isolated library imported twice yields two bindings and two databases.
- Renaming an import alias with a `needMoves` entry keeps the same database; without one the run is refused with `ERR_NEED_BINDING_ORPHANED` naming both paths, and never boots on an empty database. A move applied by two replicas at once yields one binding.
- `telo needs` on an application whose resources start others through a statically followed source lists their bindings with nothing booted.
- A watch-session edit that adds a need is bound with the pod unchanged.
- A restarted pod, a suspended and resumed session, and a second runner replica all return the same database, the same `Telo.GeneratedSecret` value and the same `Telo.DurableDirectory`; a deleted session leaves nothing.
- An integration test that starts an application needing PostgreSQL passes on a machine with only a container engine; two such tests run concurrently see different databases; after the suite exits no container from it runs, and a test killed mid-run loses its container within the lease period.
- The root suite passes with no container engine installed.
- After `telo install`, a run whose only needs are download-fulfilled succeeds with the network off.
- After `telo install` on an application with a download-fulfilled need, a container-fulfilled need and a `Telo.GeneratedSecret`, `telo needs --held` lists nothing, no container runs, and `.telo/needs/` holds prepared material only. A run with no prior install and the network on succeeds.
- An offer whose `prepare:` reads `binding.id` fails `telo check`.
- A manifest binding `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME` as five variables opens a connection through one inline `Postgres.DatabaseAccess`, and `telo needs` on it lists nothing. Omitting a required field is `NEED_SLOT_MISMATCH` at check and at boot.
- A library declaring `resources: { db: { kind: Postgres.DatabaseAccess } }` is refused with `RESOURCE_INPUT_NEED_TYPE` at check and at boot.
- In one `with:`, a lease and a `Postgres.Connection` referencing it boot with no `targets:` entry for the lease; three leases in one sequence send one acquire message; a lease the supplier cannot answer fails with `ERR_NEED_UNMET` and no sibling's init ran.
- No fulfilled value appears in the pod spec of a k8s session.
- An offer published outside the repo, listed first in a catalog's `offers:`, answers a need a later offer also matches; reordering the list afterwards leaves the binding on the offer that made it.
- An `acquire:` outlasting the start deadline refuses that run with `ERR_NEED_UNMET` saying it is still provisioning, and the next run boots on the same binding with one fulfilment created.
- An application importing a library that needs PostgreSQL, with no `needs:` of its own, boots against an existing database after one `telo needs bind`, on an empty catalog; `telo needs --held` lists it as external, and releasing it leaves the database untouched.
- An offer with `rotate:` replaces a running application's credential: the connection is re-created, queries keep succeeding past the old credential's expiry, and no resource that does not consume the need is re-created.
- A `freeze` migration with a transfer between two offers, under a workload writing throughout, ends with every acknowledged write in the new database and the old one read-only and still held; `--abort` before cutover leaves the application on the old one with no successor held.
- A `rolling` migration of a two-replica session cuts over with no failed request, each replica adopting at its own refresh.
- A `freeze` migration from an external binding is refused with `ERR_NEED_FREEZE_UNSUPPORTED`, and `--transfer` on a catalog with no transfer for the type with `ERR_NEED_TRANSFER_UNAVAILABLE`, both with nothing provisioned.
