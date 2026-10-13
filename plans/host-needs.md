# Host needs

A module declares what it needs from whatever runs it — a backing service, host software, a co-located process, durable storage, its public address, a generated secret — and the host fulfils it or refuses to boot.

## Before

- A backing service is a hand-filled `variables:` / `secrets:` entry. Nothing says "this is a PostgreSQL 15 with pgvector", so no host can supply it.
- A module that spawns `ffmpeg` or opens a system library it does not ship fails at first use, on whichever host lacks it.
- A directory that must survive a restart, the application's own public URL and a key that must be generated once are ordinary values the operator has to know to provide.
- A test that needs a database gets its connection from env the developer set up by hand, and nothing about an application started with `App.Instance` is checked statically.
- `.telo/` is one tree documented as a cache, so nothing telo writes locally may be anything but re-fetchable.

## After

### Need types

- `kind: Telo.NeedType` registers a kind `<Module>.<Name>`, exported through `exports.kinds` and gated like any other. Any library may export one, so the vocabulary is open by publication and Telo owns no list.
- A type owns: `fields` (JSON Schema property map of what a fulfilment hands over; a field may be `x-telo-sensitive: true` and carry an `x-telo-type`), `parameters` (schema of what a need may ask), `features` (the closed list of feature names for this type), `version: semver` when fulfilments of the type are versioned, and `probe:` (see Verifying a fulfilment), required when the type declares `version` or `features`.
- A type's identity is its declaring module's location plus its name, independent of the module's version. Types evolve additively.
- A need type is named for what its fulfilment hands over: `<Thing>Access` when that is the address and credentials of something outside the application, `<Thing>` being the exact unit the credentials are scoped to (`Postgres.DatabaseAccess`, `Redis.ServerAccess`, `S3.BucketAccess`, `OpenAI.ApiAccess`); the bare noun when the fulfilment is the thing itself on the host (`Ffmpeg.Executable`). The name of the object itself stays free for a kind that creates or owns it.
- Three types are declared by the kernel: `Telo.DurableDirectory` (parameters `size`, `access: single-writer | shared`; field `path`, a `Telo.HostPath`), `Telo.PublicUrl` (parameter `port`, a key of the root's `ports:`; field `url`, a `Telo.Url`), `Telo.GeneratedSecret` (parameter `bytes`; field `value`). The kernel declares them and fulfils none; a supplier answers them like any other type.

### `Telo.Url`

- A new value type for a URL that may carry credentials. It is written as its text (`postgres://app:…@db.internal:5432/orders`) or as an object — `scheme`, `host`, `port`, `user`, `password`, `path`, `query` — whose members the type escapes, so nobody assembles a URL out of a generated password.
- In CEL it is a nominal type, not a `string`: its members are read by name, and `string(url)` is its text. The `password` member is sensitive on its own, so reading `host` is never redacted and reading `password` or the whole text always is.
- An env value supplying a `Telo.Url` is its text. Text that does not parse is refused naming the variable, never printing the value.

### Declaring a need

- `needs:` is a block on a `Telo.Application` or `Telo.Library` doc, keyed by a camelCase name. An entry has `kind: <Alias>.<Name>`, and optionally `version` (a range in the `requires:` comparator grammar, legal only when the type is versioned), `features` (a subset of the type's list), `parameters` (literals), `optional: true` and `movedFrom` (see Renames).
- An entry is a declaration of that kind in the module's scope, as a Library `resources:` entry is. It shares the module's one namespace (`DUPLICATE_RESOURCE_NAME`) and is named by `!ref <name>`.
- The two blocks stay separate contracts: a `resources:` entry is a live instance its importer must hand over, a `needs:` entry is a value any level up to the host may supply. A Library `resources:` entry whose kind is a need type is `RESOURCE_INPUT_NEED_TYPE` (`ERR_RESOURCE_INPUT_NEED_TYPE`), with the repair "declare it under `needs:`".
- A need declares no fields. One field is read as `resources.<name>.<field>`, typed from the need type and closed to its fields, readable at startup in `!cel` and in every `!interpolate` hole. A whole fulfilment is always handed over by `!ref`, never as a CEL value.
- A fulfilment is always every required field of its type, delivered whole to the module instance that declared the need, whichever door supplied it and however its consumers read it.
- A field keeps its type and its sensitivity: a sensitive field is redacted wherever it is read, as a `secrets.` value is.
- An optional need is nullable and reading it unguarded is `CEL_NULLABLE_ACCESS`.
- A library declares `Telo.PublicUrl` without `port`; its importer binds the port in the import entry.

### A kind that consumes a need

- A kind that takes a whole fulfilment declares an ordinary reference slot: `x-telo-ref: { kind: Self.<NeedType>, use: dependency, follows: true }`. The controller resolves it like any reference and receives the fulfilment's fields. The type and its consumer are tied by the same link, and the same check, as any other slot in the module.
- The slot accepts any declaration of the need-type kind: a need, a lease or a self-supplied fulfilment. That is the only shape it accepts, so values enter by becoming such a declaration.
- A need of another kind at the slot is `REFERENCE_KIND_MISMATCH`; a non-reference is `INVALID_REFERENCE_FORM`; a computed value is `REF_SLOT_COMPUTED`.
- A `!ref` to an `optional: true` need at a kind's reference slot is `NEED_OPTIONAL_REFERENCED` (`ERR_NEED_OPTIONAL_REFERENCED`). An optional need is consumed by guarded field reads, or forwarded to a need that is itself optional.
- `Postgres.Connection` takes `database`, a following reference to `Self.DatabaseAccess`, and `connectionString` is removed: where the database is has one home. `Postgres.DatabaseAccess` has one field, `url`, a sensitive `Telo.Url`.
- Every stdlib module with a backing service follows the same pattern: the module that opens the connection exports the need type and a kind whose slot references it and follows it.
- A slot that holds one scalar — a file path, an API key — keeps taking one field by CEL.

### A fulfilment held by the module

A resource declared with `kind: <need type>` is a fulfilment the module holds. It satisfies the same reference slot and is read the same way as a need — `resources.<name>.<field>`, at startup — and it states one of two sources.

- **Self-supplied** — it carries `fields:`, the same construct as a `Supply.Offer`'s: it must yield every required field of the type (`NEED_SLOT_MISMATCH`), and a key the type does not declare is `NEED_FIELD_UNDECLARED`. Each value is a literal or startup `!cel` / `!interpolate` over `variables`, `secrets` and other resources' startup-readable readings; observed state stays refused there. A `Telo.Url` field is assembled in its object form, each member a literal or CEL.
- A self-supplied fulfilment never reaches a supplier: it has no binding, no scope and no entry in the needs report. It is an ordinary configured resource in the init order.
- **Lease** — it carries no `fields:`, and optionally the same `version` / `features` / `parameters` as a need entry, all literals. The supplier is asked, and the fulfilment lasts as long as the context declaring the lease.
- Declared in a `Run.Sequence`'s `with:`, a lease's lifetime is the sequence — which is how a test gets a database that exists only while the test runs. Declared as a module-level document, it lasts as long as the module instance and is released at teardown, never retained.
- `fields:` beside `version`, `features` or `parameters` is `NEED_FULFILMENT_SOURCE_CONFLICT` (`ERR_NEED_FULFILMENT_SOURCE_CONFLICT`).
- A need-type kind has no capability a `targets:` entry accepts: nothing runs a lease, and listing one there is the existing reference-kind refusal.

### Verifying a fulfilment

A need's `version` and `features` are checked against the fulfilment itself, never against what its source says about it.

- `probe:` on a `Telo.NeedType` is a `!ref` to an invocable the type's own module declares. Its inputs are the fulfilment's fields and the features asked; its result is the actual `version` and the `features` present. Its sensitive inputs inherit the type's `x-telo-sensitive`.
- A type declaring `version` or `features` with no `probe:` is `NEED_TYPE_UNVERIFIABLE`; a probe whose contract is not that one is `NEED_PROBE_INVALID`.
- The kernel about to hand a fulfilment to its consumers runs the probe on every need or lease that states a `version` or `features`, whichever door supplied it — an import's supply, a self-supplied fulfilment, a root `env:` name, a supplier's answer — before any resource of that context initializes. A need stating neither runs no probe.
- A mismatch is `ERR_NEED_UNMET`, terminal, naming the need, what supplied it (the env name, the offer entry or the supplying declaration) and the required against the actual. A supplied optional need that fails is refused, never read as absent.
- A probe that cannot reach the fulfilment is retried with backoff under the start deadline, then `ERR_NEED_UNVERIFIED`, which is retryable. The probe's declared `throws:` is what separates "answered and does not satisfy" from "could not be reached".
- An offer's `version` and `features` remain what matching selects by; the probe is what verifies.

### Bubbling, forwarding and bindings

- A need nobody supplies bubbles up the import closure to the root. An application author writes nothing for a need they neither use nor override.
- An import entry's `needs:` map supplies a library's need — whole, with a `!ref` to any declaration of that kind in the importer (a need, a lease or a self-supplied fulfilment), or field by field, each a literal or CEL (`url: !cel "resources.database.url"`), which is how one fulfilment feeds a need of a different type. A supplied need leaves the aggregate.
- A need or lease forwarded whole to a need whose `version` range it does not lie within, or whose `features` it does not include, is `NEED_FORWARD_INCOMPATIBLE` — so the supplier matches on the constraints the consumer actually has.
- The field-by-field map is a self-supplied fulfilment written anonymously, its kind implied by the target's declaration and its checks the same — so an importer supplies a need without importing the module that exports its type.
- A binding belongs to a module instance. An `isolated` library gets one binding per import; a `shared` library gets one for the whole application, and what its importers forward joins the existing rule that every import of a shared library must agree.
- Two libraries, or two started applications, needing the same type get separate bindings unless one need or one lease is supplied to both.
- A binding path is dot-separated segments — the need's name beneath each importer's alias and each starting resource's name — each an identifier or, where it holds a file location, a quoted string.

### Started applications

- `x-telo-application-source: { variables?, secrets?, ports?, needs?, supplier? }` on a literal string property of a kind's schema says the value is the location of an application the resource starts. Each key is a JSON Pointer to the sibling that supplies that part of the started application. The annotated field takes no computed value, so it carries no `x-telo-eval`.
- The loader follows the field as a start edge. Each resolved source is loaded and analysed once, however many resources start it, and is part of the closure `telo install` and `telo changed` see.
- The keys of the `variables`, `secrets`, `ports` and `needs` maps must be declared by the started application, and their values are type-checked against its declarations. A `needs` value takes the same two forms as at an import.
- What the `needs` map leaves unsupplied joins the starter's own report, pathed under the starting resource's name, exactly as an import's does. When the `supplier` slot is written — a `!ref` to a `Telo.NeedSupplier` — those needs go to that supplier instead and leave the starter's report.
- `App.Instance` annotates `source` with all five pointers and gains `needs:` and `supplier:`.
- `Test.Suite` is not followed: its children are chosen by globs and command-line arguments, so the set is not manifest content. `telo needs report` on the suite lists only the suite's own needs, and the suite gains the same `supplier:` slot.
- A child started outside the static closure is still nested under its starter's application, never given an identity of its own: its paths carry the starting resource's name and one quoted segment holding the child's source location relative to the starter's module.
- `Assert.Manifest` is not annotated: its target is expected to fail, and following it would put the expected errors into the parent's check.

### Scope and lifetime

Every binding has a scope, and the scope fixes who may end it.

- `application` — a need declared in a `needs:` block. Retained: workload exit, restart, reload and suspension never release it. Only the host authority does — session deletion on a runner, `telo needs release` locally. Retention covers the binding's identity and data; whether its compute runs while no holder is attached is the supplier's choice.
- `resource` — a lease. Resolved by the kernel when the context declaring it opens — at load for a module-level one, at each run of the scope for one in a `with:` — before any resource of that context initializes, so every consumer sees its fields at its own init and no resource's init or run performs supplier I/O. Released when that context tears down, extended by each refresh naming it, and reaped by the supplier when it stops being named — which is what cleans up after a test that crashed and never reverted anything.
- A lease is per opening, not per path: the kernel mints an opening id once per context open, and two concurrent runs of one sequence hold two leases. Every lease of one context is resolved in one message under that id, under the opening invocation's cancellation and deadline; a retry or a poll reuses the id, so a timed-out open returns to the same leases and never leaks a second set.
- An unmet lease is `ERR_NEED_UNMET` and a timed-out one `ERR_NEED_PROVISIONING`, before any resource of that context initializes; the leases that message already granted are released. A lease no offer matches is refused earlier, by the prepare every load sends.
- A lease the supplier reports gone cancels the scope run holding it with `ERR_NEED_LEASE_LOST`.

### Renames

A retained binding has an identity of its own, which its path points at, and a path has several authors — the need's name, each importer's alias, a starting resource's name. Changing any of them changes the path.

- `movedFrom` is a list of binding paths relative to the declaring module instance, naming where the declaration carrying it formerly was. It is legal on a `needs:` entry, on an import entry in its object form, and under any resource's `metadata`. One segment is a rename; more is a re-homing. On an import or a starting resource it covers every binding beneath.
- The destination of a move is always the declaration carrying the key, so a module gives a past only to what it declares. A binding is moved up by the new owner naming the old path, and is never moved down: it is kept by keeping the need that owns it and its forward.
- A `movedFrom` path the report still holds is `NEED_MOVE_SOURCE_DECLARED`; one former path reached by two entries is `NEED_MOVE_SOURCE_CLAIMED_TWICE`; an entry that is not a binding path is `NEED_MOVE_PATH_INVALID`; `movedFrom` where no binding path passes is a `NEED_MOVE_INERT` warning.
- Each report entry carries `formerPaths`: every path obtained by substituting a declared former prefix at each import and starting-resource segment of its path, plus the need's own `movedFrom` paths under each of those prefixes — at most 16 (`NEED_MOVE_LIMIT`).
- At resolve, a binding held at exactly one former path with nothing held at the current one is re-keyed atomically when the need type matches, carrying a migration in progress whole; the answer names the former path and the kernel logs `NEED_BINDING_REKEYED`. Held at more than one of the current and former paths is `ERR_NEED_BINDING_CONFLICT`; a different type is unmet, with that reason.
- An orphan is a held retained binding at no declared or former path. When the same resolve would create a fresh binding of the same need type, the run is refused with `ERR_NEED_BINDING_ORPHANED` before any resource initializes and with nothing provisioned; the message names both paths and the two repairs — a `movedFrom` entry on the declaration now carrying the path, or `telo needs release`. Otherwise it is a `NEED_BINDING_ORPHANED` warning. An orphan is never released automatically.
- A `movedFrom` entry is deleted once no environment holds a binding at it — for an application, after each scope has run once on the manifest carrying it; a library keeps it for as long as it supports upgrading from the version that used the name. Deleting one too early is the orphan refusal, repaired by restoring it.
- A library switching `lifecycle` changes how many bindings exist, which is not a move: the importing application keeps the one it chooses by declaring a need of its own with `movedFrom` and forwarding it. A changed child-location segment is the host's fact and has no manifest cover.
- An editor rename of an Application's need, an import alias or a starting resource appends the old name to that declaration's `movedFrom` in the same edit, and rewrites no other `movedFrom`; renaming back to a listed name removes it. Renaming a Library's `needs:` key is refused as public surface.
- `metadata.name` of a module is in no key, so renaming it changes nothing. A manifest's file location is the host's locator, covered under The host, scopes and applications below.

### Supplying a need from the environment

- A root Application's `needs:` entry may carry `env: { <field>: <NAME> }`. That is the only way a need is read from the environment: no name is derived, and a field the root did not bind has no env name.
- A set bound name wins and the supplier is not asked for that need. One manifest therefore runs both ways, the operator choosing at start. An `env:` map must bind every required field of the type (`NEED_SLOT_MISMATCH`), and when any bound name of a need is set, every required one must be (`ERR_NEED_PARTIALLY_SUPPLIED`).
- Precedence is fixed: a `needs:` supply at an import or application source, then a set root `env:` name, then the supplier. Env precedes the supplier because a workload with no reachable supplier must boot from env alone.
- The supplier is told which paths were env-supplied. A retained binding held at such a path is left alone and the run warns `NEED_BINDING_BYPASSED`, naming the path and the env name.
- A need supplied by env never refreshes: its value is the process's own. It has no revision and is absent from refresh.
- A library cannot bind env (`LIBRARY_ENV_KEY_REJECTED`). A root makes a library's need env-suppliable by declaring a need of its own with `env:` and forwarding it at the import.
- An `env:` key naming no field of the type is `NEED_FIELD_UNDECLARED`. A bound name equal to another need field's, or to a `variables` / `secrets` / `ports` env name, is `NEED_ENV_NAME_COLLISION`.
- A bound name reads `undefined` from the process environment inside the workload, as a bound variable's does.

### The needs report

- `telo needs report <manifest>` prints, with nothing booted and no supplier contacted, one entry per unmet binding across the whole tree, statically followed started applications included: its path, `formerPaths`, `scope`, declaring module, type, version range, features, parameters, whether it is optional, which of the type's fields are sensitive, each field's bound env name when it has one, and `adoption: live | restart`. It carries no values.
- The document is versioned and extensible. It is the one input to fulfilment on every host — a runner and the studio read the bound env names from it — and the document a later CPU/memory estimate joins.

### Suppliers

- Whoever starts an application is its supplier. A root's starter is the CLI or a runner; a started application's is the resource that started it, which answers what its `needs:` supplies and passes the rest to its own supplier, or to the one its `supplier:` slot names.
- That relay belongs to the mechanism that starts a child application, not to any kind: every kind starting one through it relays, so a supplier given to a suite reaches every test it runs. The relay carries the workload messages only, and prefixes paths; a child never chooses its application.
- `Telo.NeedSupplier` is a kernel built-in abstract: a resource of a kind extending it answers the supplier contract. It is what a `supplier:` slot accepts and what a host runs.
- The document a host runs as supplier is a `Telo.Application` carrying the Application-only key `supplies: !ref <name>`, a reference to a resource whose kind extends `Telo.NeedSupplier`. Its `variables` / `secrets` bind env like any root's, which is where an operator's account and credentials come from. `supplies:` on a Library is refused, and a host pointed at an application without it fails with `ERR_SUPPLIER_NOT_DECLARED` before the workload loads.
- The supplier contract is normative and is two message sets, divided permanently by who speaks them: the workload set of four, sent by a kernel, and the host set of three, sent by a host. The supplier application is a process of its own, possibly on another telo version and another kernel than its host, which is why both sets are wire contracts. Scope and application travel as opaque strings the host mints.
- Each set has its own generation, and every request states its set's generation; the supplier answers in it. Within a generation fields are added and an unknown field is ignored. A supplier serves every generation its host still admits, so a later change is an additive field or a generation served beside the old one. A generation the supplier does not serve is refused with `ERR_NEED_SUPPLIER_INCOMPATIBLE`, naming both generations, before any resource initializes.
- A message is normative from the step of the work that first sends it.
  - Workload authority:
    - prepare — the report in; per entry an answer of prepared, nothing to prepare, or unmatched (with a reason). It fetches what a fulfilment needs on disk and is idempotent; it creates no binding, mints nothing and starts nothing. A path holding a retained binding is answered from that binding's recorded offer entry, so it agrees with what resolve will return.
    - resolve — per entry one answer: bound, pending (polled under the starter's deadline) or unmet (with a reason). A request has two optional parts: the application's complete retained set with the env-supplied paths, sent at load, which is the only part re-keying and orphans are answered for; and one opening — its id and every lease of that context. A module-level lease opens at load, so it travels in the load's resolve beside the application's needs.
    - refresh — a `holder` id minted per kernel boot and every binding it holds in, each with the revision it has adopted and, for a blocked one, the reason; per binding `unchanged`, `changed` (fields, `revision`, `expiresAfter`) or `gone` (with a reason) out. Refresh never creates, re-keys or provisions, so a binding released under a running workload answers `gone` and is not resurrected.
    - release — the opening ids of contexts that tore down; every lease of each ends.
  - Host authority, which a workload's own token can never send:
    - migrate — moving a retained binding to another fulfilment, named by an opaque supplier-defined target or as its superseded one.
    - list — the held bindings of a scope without values, paged by an opaque cursor.
    - release-retained — ending retained bindings selected by scope, optionally narrowed to one application, then to one need path, then to one of that binding's current, superseded or successor fulfilments, with `forget`. A selector naming a fulfilment without a need path is refused.
- A bound answer carries the field values, a `revision` (opaque, compared for equality only), an optional `expiresAfter` (a `Telo.Duration` from receipt: how long these fields still open new sessions), the fulfilment's `footprint` when it has one and, when this resolve re-keyed the binding, the former path it was held at.
- Every resolve and refresh response states `refreshAfter`, bounded by a maximum the contract declares; the kernel sends its next refresh then, less jitter. One refresh per supplier covers every binding of both scopes: a lease named in it is extended, and a holder not heard from within its window is no longer attached.
- The spec sits beside the controller protocol's as `kernel/specs/need-supplier.md`, its message data and one generation per set under `sdk/need-supplier/`, and `pnpm run check:need-supplier` checks the two against each other in both directions.
- A kernel carries a client for the workload set only, `Telo.NeedType` and `Telo.NeedSupplier` — no sender of a host-set message, and no vocabulary for how a need is fulfilled.

### Offers and catalogs

Fulfilment is ordinary modules, so a new way to fulfil a need ships without a telo release.

- The `supply` module exports `Supply.Offer`, `Supply.Transfer` and `Supply.Catalog`. It reaches the contract through `@telorun/sdk` only.
- `Supply.Offer` states how a type is fulfilled: `provides: <Alias>.<Name>`, `version`, `features`, a platform `selector` (`os` / `arch` / `libc`), an optional `footprint` (`cpu`, `memory`), optional `prepare:`, `acquire:`, `rotate:` and `release:` step bodies in the shared step grammar, an optional `freeze: { apply, revert }` pair of step bodies, `fields:`, and optional `transferFields:`.
  - `provides` is declared with `x-telo-need-type: { fulfilment, version, features }` — the value names a need type, and each key is a JSON Pointer to the sibling holding that part. `fields:` must yield every field of the named type (`NEED_SLOT_MISMATCH`), `version` and `features` must be admitted by it (`NEED_PARAMETERS_INVALID`), and a name resolving to no need type is `NEED_TYPE_UNRESOLVED`.
  - `prepare:` fetches what the fulfilment needs on disk, per host and independent of any binding; it is dispatched whenever its results are needed and does nothing when the material is present. Its CEL scope holds the request's `parameters`, `features` and version and the platform selector, and no `binding`, so reading `binding.*` there is the existing unknown-name refusal at `telo check`. Its results are read as `prepared.<step>.result`.
  - `fields:` is CEL over `binding.id` and `binding.secret` (generated per binding and stable for its life), `binding.parameters`, `binding.features`, `binding.placement` (see Workload hosts), `prepared.<name>.result`, `steps.<name>.result` of the `acquire:` body and `rotated.<name>.result`, typed from each invoked kind's `outputType`.
  - An offer with no body is static.
  - `rotate:` yields the binding's current credentials, minted or read from wherever they are rotated. It runs after `acquire:`, and again when a resolve or refresh arrives after `rotateAfter:` — a `Telo.Duration`, literal or CEL over `rotated.<step>.result`, required beside `rotate:`. `expiresAfter:` states how long the result stays valid. A run changes the binding's revision only when the fields differ, so an externally rotated secret is a `rotate:` that reads it. Each run is claimed first with a `rotation.id` and `rotation.secret` the body names what it creates from; no timer runs it, and a binding nobody holds mints nothing.
  - `freeze.apply` returns once the fulfilment can acknowledge no further write; `freeze.revert` makes it writable again. Both are required when `freeze:` is written. It is what lets a transfer out of this offer lose nothing.
  - `transferFields:` is the same construct as `fields:` with the same checks: the fulfilment as a transfer running in the supplier should reach it — an elevated credential, a supplier-reachable address. A transfer reads it in place of the bound fields when declared.
  - `release:`, `freeze.apply` and `freeze.revert` read `binding` and the bound fields only.
  - Any body may be dispatched more than once for one binding, so everything it creates is named from `binding.id` or, in `rotate:`, from `rotation.id`.
  - An offer runs its own bodies: the catalog asks the offer instance, so a body's `invoke:` resolves in the module declaring the offer, which may keep those kinds unexported.
- `Supply.Transfer` moves the contents of one fulfilment of a type into another: `moves: <Alias>.<Name>` (declared with `x-telo-need-type`), a required `copy:` and optional `finalize:` and `abandon:` step bodies whose CEL scope holds `from` and `to`, each typed as that type's fields, and `migration.id`, from which everything a body creates is named.
  - It is declared per need type, never per pair of offers, so one transfer covers every source and target of the type.
  - `copy:` makes `to` hold what `from` holds, replacing what was there; it is repeatable and runs while the source serves. Under the freeze the catalog runs `copy:` once more and then `finalize:`, which is what must happen exactly once after the last copy. `abandon:` runs on abort and removes what `copy:` left on the source. A step that moves data moves it as a stream.
- `Supply.Catalog` extends `Telo.NeedSupplier`. It takes `offers:` — a list of `{ name, offer, when? }` — `transfers:` (a list of `!ref`) and a required `store:` (a `KvStore.SealedStore`). It owns matching, pending answers, retained bindings persisted by conditional write, re-keying, rotation claims, migration, and lease expiry and reaping.
  - An entry's `name` is camelCase and unique in the catalog (`SUPPLY_OFFER_NAME_DUPLICATE`); `offer` is a `!ref` or inline; `when:` is CEL over `need`, the report entry (`path`, declaring module, type, version range, features, parameters, scope).
  - The order of `offers:` is preference: the first entry matching a need's type, version, features and platform, and whose `when:` holds, answers it. `when:` is read only when a binding is first made.
  - A retained binding records the entry's `name` and stays with it: reordering, or changing how the entry reaches its offer, never moves a fulfilment; only a migration does. A binding whose entry is no longer listed is unmet with `ERR_NEED_OFFER_MISSING`, naming the path, the entry and the repairs, and is never re-matched or released automatically. An entry stays listed until every fulfilment it made, a superseded one included, is released.
  - The order of `transfers:` is preference: the first whose `moves` is the need's type is used unless a migration names one.
  - Per binding it stores the path, type, entry name, `binding.id`, `binding.secret`, body results, state, claim, revision, a digest of the computed fields and timestamps — never a field value and never `prepare:` results, which are host-local. A static offer whose computed fields differ from the stored digest is a new revision.
  - A body runs in the process hosting the supplier under a claim on the binding, taken and renewed in the store, so one body runs per binding across any number of replicas, and an expired claim lets the next resolve re-dispatch it for the same `binding.id`. Only one replica runs a migration's phases at a time, under the same kind of claim.
  - When a starter's deadline passes before an `acquire:` finishes, that run is refused with `ERR_NEED_PROVISIONING`, which is retryable; `ERR_NEED_UNMET` is terminal — no entry matches, or a body failed. A runner-hosted supplier finishes the body; a CLI-hosted one ends with its process and the next run re-dispatches. A plain `telo run` has no start deadline and waits, reporting on stderr which path is provisioning through which entry.
  - Asked to resolve something unprepared, it prepares it first, so a run with no prior install behaves the same.
- What a body invokes lives in its own module:
  - `supply-container` — `ContainerSupply.Run`, `ContainerSupply.Remove`, `ContainerSupply.RemoveVolume` and `ContainerSupply.Pull`, which ask the supplier's host for a workload and launch nothing themselves (see Workload hosts).
  - `supply-download` — `DownloadSupply.Fetch`, with entries in the module `sources:` entry shape, returning each as a `Telo.HostPath`. A download-fulfilled offer invokes it in `prepare:` and has no `acquire:`.
  - `supply-local` — ready-made offers for the three kernel-declared types, answered under `.telo/state/needs/`, with `Telo.PublicUrl` as the local address of the port.
- Offers and transfers for a type live in their own module, never in the module declaring the type: PostgreSQL's are `supply-postgres`, which imports `postgres`, `supply` and `supply-container`, while `postgres` imports none of them.
- A database per binding on a managed server is an offer whose `acquire:` runs SQL steps; it needs no host code.
- A third party fulfils a type the same way: a vendor publishes a module importing the type's module and `supply`, exporting an offer instance for its managed service and the kinds its bodies invoke. The operator's supplier application imports it, supplying account and region through the import's `variables` / `secrets` from its own env-bound ones, and lists the offer in `offers:`. A vendor ships offers, never a supplier.
- An offer and a transfer are exported through `exports.resources`, so the hub finds them as instances of `Supply.Offer` and `Supply.Transfer`.

### Workload hosts

An offer body requests a workload; the host of the supplier creates it. Placement, network admission, quota and lifetime are the host's, never the offer author's.

- The workload-host contract is normative with four messages — image, run, remove, remove-volume — sent by `supply-container` and served by whatever hosts the supplier. It has its own generation under the supplier contract's rule: stated per request, additive within it, older generations served beside newer. Its spec is `kernel/specs/workload-host.md`, its message data and generation under `sdk/workload-host/`, checked both ways by `pnpm run check:workload-host`.
- A host that starts a supplier application gives it `TELO_WORKLOAD_HOST_URL` and a host-authority `TELO_WORKLOAD_HOST_TOKEN`. The supplier application binds them as a variable and a secret and passes them to its `supply-container` import. A runner advertises the contract as `features.workloads` on `/v1/capabilities`; the CLI serves it over the local container engine for a supplier it hosts.
- `binding.placement` is one opaque host-minted value derived from the binding's scope and application strings, readable in `acquire:`, `rotate:`, `release:`, both `freeze` bodies and `fields:`, and redeemable only by the host. It is absent from `prepare:`, where reading it is the existing unknown-name refusal. A placement that is not the requesting binding's is refused by the host.
- `ContainerSupply.Run` takes `placement`, `name`, `image`, named `ports`, `env`, `resources` (`cpu`, `memory`), `volumes` and `ready` as either `port: <name>` accepting a connection or a `command:` exiting zero inside the container. It returns `host` and `ports` as seen from the session, and `supplierHost` and `supplierPorts` as seen from the supplier, which is what `transferFields:` reads.
- A workload is named from `binding.id`; a repeated `Run` for the same placement and name returns the existing workload's addresses.
- The host places, labels and networks the workload. It applies `resources` as the workload's real limits and counts those against the session; a request the session cannot hold is refused with `ERR_WORKLOAD_QUOTA_EXCEEDED`, never clamped, and reaches the workload as `ERR_NEED_UNMET` with that reason. An offer's `footprint` is never an input to quota.
- A workload's data lives in volumes, whose lifetime is not the workload's. `volumes:` is a list of `{ name, mountPath, size }`; the host ensures each exists for the placement and mounts it, reusing one it holds and never recreating it — a named volume on a container engine, a persistent volume claim on a cluster.
- `size` is fixed at creation and counts against the session's storage quota, refused with `ERR_WORKLOAD_QUOTA_EXCEEDED` like `resources`. A `Run` naming an existing volume with another `size` is refused with `ERR_WORKLOAD_VOLUME_IMMUTABLE`.
- The host records every volume it created, per placement, in its scope record. A `Run` naming a volume that is recorded and no longer found is refused with `ERR_WORKLOAD_VOLUME_LOST`, reaching the workload as `ERR_NEED_UNMET` with that reason, and creates nothing: a binding never boots on a fresh empty volume.
- `ContainerSupply.Remove` takes `placement` and `name` and ends the workload only, which is how an offer stops the compute of a binding nobody holds and keeps its data. `ContainerSupply.RemoveVolume` (`placement`, `name`) ends the storage, whether or not a workload still exists; an offer's `release:` invokes both.
- Independently of either, the host removes every workload and volume of a placement when its session is deleted or its local scope is released, whether or not `release:` ran; a runner's boot-time orphan reaper covers them. Suspension removes neither.
- `ContainerSupply.Pull` (`image`) returns the image pinned by digest, invoked in `prepare:`. On a host with a local image store it fetches, and does nothing when the image is held; elsewhere it only resolves. `Run` never pulls: on a host with a local store an absent image is `ERR_CONTAINER_IMAGE_ABSENT`.
- A supplier with no workload host refuses `Run` with `ERR_WORKLOAD_HOST_UNAVAILABLE` — the case of a catalog in a `supplier:` slot.
- `supply-container` holds no container-engine or cluster client.

### Sealed stores

- `kv-store` gains the abstract `KvStore.SealedStore`, extending `KvStore.Store`: no value reaches a durable medium in a form readable or alterable without key material held outside that medium. A catalog over a plain store is the existing `REFERENCE_KIND_MISMATCH` at `telo check`, and the catalog refuses it at creation.
- `kv-store-sealed` exports a `Store` extending it. It takes `store:` (any `KvStore.Store`) and `keys:`, an ordered list of `{ id, key }` with `key` a 32-byte `Telo.Bytes` taken from the supplier application's `secrets:`; the first is primary.
- Every record is sealed whole, with its own key bound in so a record copied to another key does not open. Nothing is selected by `x-telo-sensitive`, which keeps governing trace redaction only.
- Values are sealed under a data key kept in one keyring record, wrapped under every configured key. Adding a new first key re-wraps that record on first use, so rotation is two deploys — the new key added, then the old removed — and needs no key enumeration.
- A record or keyring no configured key opens is `ERR_NEED_STORE_UNREADABLE`, naming the key id it was sealed under and the configured ids, with nothing provisioned. It is never read as absent.
- The in-memory store extends `KvStore.SealedStore` directly, having no durable medium.
- `kv-store-file` is a file-backed `KvStore.Store` (owner-only files), the inner store of the CLI's default supplier.
- The record envelope and keyring format are normative in `kv-store-sealed`'s docs, so a controller in another language reads what this one wrote.
- `supply`, `supply-container`, `supply-download`, `supply-local`, `supply-postgres`, `kv-store-sealed` and `kv-store-file` are MIT, each with `license: MIT` and its own `LICENSE`.

### Cache and state directories

- `.telo/` stays anchored as today — beside `telo-workspace.yaml`, else beside the entry manifest — and splits in two.
- `.telo/cache/` holds everything `.telo/` holds today. It is re-fetchable, read-only at run time and what an image build copies. `TELO_CACHE_DIR` overrides this directory.
- `.telo/state/` holds what telo cannot recreate. `TELO_STATE_DIR` overrides it. Neither variable moves the other directory.
- A packaged application keeps its payload cache where it is and holds its state in `.telo/state/` under the working directory.
- A tree written by an earlier release is no longer read, and the cache re-warms once.

### Fulfilment

- At every load, before any resource initializes, the kernel sends prepare with every report entry the environment has not supplied, needs and leases alike, then one resolve. An entry prepare answers unmatched, with no binding held at its path, is `ERR_NEED_UNMET` there — so a lease no offer matches refuses the load, not its first use. With the material on disk prepare fetches nothing.
- The workload names needs only — never an offer, an image or an address.
- Locally the CLI hosts the supplier, outside the workload's module scope: `--supplier <path>` or `TELO_SUPPLIER` names a supplier application. With neither set it hosts a built-in one: a catalog of the `supply-local` offers over `kv-store-file` under `.telo/state/needs/store/`, inside the sealing store.
- The default supplier's key is `TELO_NEEDS_KEY` (base64url, 32 bytes) when set. Otherwise the CLI generates `needs.key`, owner-only, in the user's state directory — `$XDG_STATE_HOME/telo/` (else `~/.local/state/telo/`), `~/Library/Application Support/telo/`, `%APPDATA%\telo\` — never under `.telo/`. With no usable location the run is refused naming `TELO_NEEDS_KEY`.
- `telo install` sends prepare, so everything a need's fulfilment must fetch is on disk and a later run needs no network; it binds nothing. It prepares needs and leases alike, for the platform selector it materializes module layers for, against the supplier `telo run` would use. Needs handed to an in-manifest `supplier:` slot are outside the report and are not prepared.
- The CLI-hosted catalog keeps prepared material under `.telo/cache/needs/prepared/`, content-addressed by its pinned digest.
- A runner hosts the operator's supplier application and fronts it per session, given to the workload as `TELO_SUPPLIER_URL` and a token minted per session and application in `TELO_SUPPLIER_TOKEN`. The front serves the workload-set generation of every telo version the runner admits, from its oldest supervisable release up. The applied `resources` of every workload a fulfilment runs on the host count against the session's quota, a migration's successor and superseded fulfilments included. Deleting the session releases its scope and removes the session's workloads and volumes; suspending it does not.
- A reload, a resume or a restarted pod returns the same secret and the same directory, because the binding's key holds nothing of the pod (see The host, scopes and applications).
- A container-fulfilled need runs as a separate workload the host created, reachable from the session, never as a container added to the application's pod.
- Fulfilled values never enter a pod spec or a container's env block.

### The host, scopes and applications

Hosting needs is one component, `@telorun/needs-host` (Sustainable Use), embedded by the CLI and by every runner. It is not the session contract and carries no web server: supervising sessions and hosting needs have different lifetimes.

- It owns the scope record, the application registry, minting and redeeming `binding.placement`, quota accounting, the volume record, the per-application supplier token, the needs actions (held, release, release-scope, migrate, relocate), the displacement and supplier-mismatch refusals, sending the host set, and serving the workload-host contract. `telo needs …` and a runner's `needs` routes are two transports over that one action set.
- It has two seams, each implemented by the artifact that owns the substrate: workloads and volumes (the local container engine, the docker socket, the cluster API), and record persistence with conditional writes (files for the CLI, the runner's own durable medium otherwise). The record format is one on every host.
- A retained binding is keyed by scope id (`scp_…`), application id (`app_…`) and need path on every host; a lease adds its opening id. Both ids are minted by the host, hold at least 128 random bits and are written in Crockford base32, since people type them.
- Everything else is a locator the host maps to an id, never a key: the `--needs-scope` name, a session id, a manifest's location, `package:<payload application name>` for a packaged application (so a new build keeps its bindings), and on a runner the session application's `name`. `metadata.name` is in no key and no locator.
- A scope is owned or borrowed. One the host created for a session is released with that session — every container runner. One a start was pointed at is ended only by `telo needs release-scope` — `--needs-scope` or `TELO_NEEDS_SCOPE` locally, default `default`. One manifest run for two purposes is two scope names.
- Locally the record is `.telo/state/needs/scopes/<name>/scope.json`: the scope id, the supplier that made the scope's bindings, each application's id with its manifest's location relative to the directory holding `.telo/`, and the volume record.
- The CLI's local-process runner backend advertises two session config properties through its `config.schema` on `/v1/capabilities`, `needsStateDir` and `needsScope`, naming a state directory and scope to attach to; the session borrows that scope, which survives the session and the runner. Without them the session gets a scope of its own, released with it.
- A runner reads its persisted records at boot and, for each whose session is gone, releases the scope and removes its workloads and volumes.
- An application is registered when a resolve first reaches the supplier for it and deregistered when its last binding is released.
- Two manifests are two applications whatever their `metadata.name`; two checkouts have two generated scope ids, so they stay apart even on a shared operator catalog; a moved checkout keeps every binding.
- A changed locator leaves a displaced application: a manifest moved inside the workspace, or a session application renamed. A start from an unregistered locator that would create a fresh binding of a type a displaced application holds is refused with `ERR_NEED_APPLICATION_DISPLACED` before any resource initializes and with nothing provisioned, naming both locators and the repairs — relocate or release. Otherwise it is a `NEED_APPLICATION_DISPLACED` warning. Nothing is re-pointed automatically; an editor that moves a manifest relocates in the same edit.
- Selecting a supplier other than the one recorded, for a scope holding bindings, is `ERR_NEED_SUPPLIER_MISMATCH` on every command, `telo run` included, naming the recorded supplier. The selection is never taken silently from the record.

### The `telo needs` commands

Every form is `telo needs <verb> …` with no default positional. An application is named by its manifest (a path, or a directory holding `telo.yaml`) or by its `app_…` id; a need by `--need <path>`. The supplier and scope are selected as on `telo run`, where both flags sit before the manifest path.

| Command | Does |
|---|---|
| `telo needs report <manifest>` | the static report |
| `telo needs held [<application>]` | list; without an argument the whole scope, displaced applications included |
| `telo needs release <application> [--need <path>] [--superseded] [--forget]` | release-retained narrowed to the application, and to the need with `--need`; without it every retained binding of the application ends in one message and the application is deregistered |
| `telo needs release-scope [--forget]` | release-retained for the whole scope, and removes the scope's record |
| `telo needs migrate <application> --need <path> …` | migrate |
| `telo needs relocate <application> <manifest>` | re-points the record of a moved manifest; no supplier message |
| `telo needs use-supplier <supplier>` | rewrites the scope's recorded supplier; no supplier message |

- `--forget` drops a record without running `release:` — the repair for a binding whose entry is gone and for an unreadable store.
- `telo needs held` joins the supplier's list with the report. Per binding: path, type, scope (with `expiresAt` for a lease), state (`bound`, `pending`, `failed`), the offer entry that made it and whether it is still listed, its `binding.id`, revision and timestamps, whether it is orphaned or bypassed by a set env name, and under migration its current, successor and superseded fulfilments, the phase and, when adoption has stalled, the reason. It shows no field value and no `binding.secret`.
- Under `-o json`, `report` writes the bare versioned report and the other verbs a result envelope.
- A runner exposes the same actions on a session, advertised as `features.needs` on `/v1/capabilities`; one without it answers `400 needs_unsupported`. `GET /v1/sessions/:id/needs` lists; `POST /v1/sessions/:id/needs/release` takes `{ app, need?, superseded?, forget? }`; `POST /v1/sessions/:id/needs/migrate` takes `{ app, need, to | toSuperseded, transfer?, transferWith?, freeze?, freezeDeadline?, adopt?, abort? }`; `POST /v1/sessions/:id/needs/relocate` takes `{ app, name }`, re-pointing a displaced application at a renamed session application. A workload token is refused on each.

### Pointing a need at an existing service

- An operator declares a static offer in the supplier application: `provides:` the type, `fields:` over the application's own `variables` / `secrets`, listed in `offers:` with a `when:` when it must answer one need only. The application is unchanged.
- Nothing is provisioned, and nothing runs at release because the offer has no `release:`. A changed value is a new revision.
- An application author offers the same door without a supplier through a root `env:` binding.

### Fields that change

A binding's fields may change while the application runs — a rotated credential, a changed static offer, a migration's cutover. A change never re-creates resources: a kernel adopts the new revision in place, or adopts nothing and is restarted by its host.

- `x-telo-ref` gains `follows: true`, legal only beside `use: dependency` (`REF_FOLLOW_INVALID`): the slot's holder survives its target's reading being replaced. When it changes the kernel calls the controller's `rebind` entry point, which returns once nothing built from the superseded reading will take new work. The controller protocol gains it as `controller-rebind` on both carriers, a new generation. A following slot whose controller has no `rebind` is `ERR_REF_FOLLOW_UNIMPLEMENTED` at creation.
- Each site consuming a need is classified statically:
  - follows — a `!ref` at a following slot; a `resources.<need>.<field>` read at a site evaluated per use (a runtime-eval field, a handler context, a step body); any consumer declared inside an execution scope, which is created per run.
  - frozen — a `!ref` at any other slot; a startup read by a module-level resource or the Application doc.
  - derived — a self-supplied fulfilment whose `fields:` read a need is re-evaluated on change and is a new reading to its own consumers; a need forwarded at an import is classified by the receiving need's consumers, through any depth.
  - A need forwarded to a started application is classified by that application's own report, which adopts independently; the resource that started it is its host.
- A report entry is `adoption: live` only when every consumer follows.
- A `changed` revision of a need stating a `version` or `features` is probed before adoption. A mismatch leaves the held revision serving and reports the binding blocked with that reason.
- Adoption is whole per binding per kernel. `live`: the kernel republishes the reading, calls every `rebind`, and reports the new revision adopted in its next refresh. `restart`, or a `rebind` that fails or exceeds its deadline: the kernel changes nothing, keeps serving on the revision it holds and reports the binding blocked with the reason.
- A host restarts a blocked workload drained, before the held revision's `expiresAfter` when one is stated and promptly otherwise: a runner restarts the session's pod, the CLI its kernel, a starting resource its application.
- In-flight invocations are never cancelled for a binding change. A sequence run keeps the revision it opened with for anything that does not follow, and the next run reads the current one.
- A refresh that fails is retried with backoff; the kernel keeps what it holds and warns `NEED_REFRESH_FAILED`. A held revision that outlives its `expiresAfter` with no successor adopted is `ERR_NEED_REVISION_EXPIRED`, reported against the need and naming its blocked consumers; it never kills the process.

### Migrating a binding

A retained binding is moved to another offer entry while the application keeps running. It is a host-authority command and is declared in no manifest: a supplier document declares what is possible — offers, transfers, a freeze — never the intent to move.

- `telo needs migrate <application> --need <path>` takes one target: `--to <entry>` (a name in `offers:`; an existing service is a static offer's entry) or `--to-superseded`. A supplier placed in a `supplier:` slot is administered by hosting the same supplier application over the same `store:`.
- Every refusal is answered before anything is provisioned. The target is matched against the type, version, features and parameters the binding recorded at its last resolve, as resolve matches an offer; one that cannot meet them is `ERR_NEED_UNMET`. A path holding no retained binding — nothing, a lease, or a need supplied by env — is `ERR_NEED_BINDING_NOT_HELD`.
- The supplier acquires a successor fulfilment for the same binding with its own `binding.id`, while the current one keeps serving.
- `--transfer` uses the first `Supply.Transfer` listed for the need's type and `--transfer-with <name>` a named one; with none, `ERR_NEED_TRANSFER_UNAVAILABLE`. Without a transfer nothing is carried: the successor is as its offer made it.
- A migration with a transfer is fenced: `copy:` while the source serves, then the source offer's `freeze.apply`, `copy:` once more, `finalize:`, cutover. Nothing acknowledged is lost, and writes fail from the freeze until each holder adopts. A source whose offer has no `freeze:` is refused with `ERR_NEED_FREEZE_UNSUPPORTED`, naming `--no-freeze`.
- With a transfer, the catalog runs the type's probe on the successor through its `transferFields:` before `freeze.apply`; a mismatch is `ERR_NEED_UNMET` with nothing frozen. Without a transfer the successor is verified by each holder's kernel as it adopts.
- `--no-freeze`, legal only with a transfer, skips the freeze: writes reaching the source after the last copy are not carried. It is for a source whose writes the operator has stopped themselves, or contents that can be re-derived.
- `--freeze-deadline <duration>` (default `300s`) bounds the frozen phase. Past it the supplier runs `freeze.revert`, the migration returns to `copying`, and the command fails naming the phase.
- Zero write downtime for carried data is not offered: the outage is the last copy under the freeze, `finalize:` and adoption. An application that needs none declares two needs and writes to both.
- Cutover is one conditional write that makes the successor current as a new revision. Before freezing, the supplier answers the binding's holders with a short `refreshAfter` and waits one maximum refresh interval. After cutover it hands the successor to at most `--adopt <n>` holders at a time (default 1), the next only when the previous reports the new revision — after a successful `rebind`, or after its host restarted it drained. A holder that fails to adopt stalls the migration with its reason. A process starting after cutover resolves to the successor. Adoption is complete when no holder has reported the old revision for two maximum refresh intervals; only the in-flight grants are recorded, never a list of holders.
- The old fulfilment is kept as superseded, still frozen, so a straggler's write fails loudly, and it is never released automatically. `telo needs release <application> --need <path> --superseded` ends it and the migration with it; it is refused before adoption completes, and until then another migration of that binding is refused.
- `--to-superseded` moves back to the superseded fulfilment, reverting its freeze as it becomes current; with `--transfer` it carries what the successor received. It is also accepted while a migration is stalled in `adopting` by a verification refusal.
- `--abort` is legal until cutover: it runs `freeze.revert` when frozen, the transfer's `abandon:`, and releases the successor.
- The phases — `acquiring`, `copying`, `frozen`, `adopting`, `superseded` — are persisted with when and by whom each was entered. Running the same command again resumes; an action the phase does not allow is `ERR_NEED_MIGRATION_IN_PROGRESS`, naming the phase and what is allowed.
- A type whose fields are its content (`Telo.GeneratedSecret`) gets different content from another offer, and no transfer changes that.

### Refusals

Reported by `telo check`, with kernel twins where one is named:

| Code | When |
|---|---|
| `NEED_TYPE_UNRESOLVED` | a `needs:` entry's `kind:`, or an `x-telo-need-type` field, naming no exported need type |
| `NEED_PARAMETERS_INVALID` | parameters, features or a version range the type does not admit; `Telo.PublicUrl` naming no `ports:` key |
| `NEED_FIELD_UNDECLARED` | a key of a field-by-field supply map, of any `fields:` / `transferFields:` or of an `env:` map that the type does not declare |
| `NEED_SLOT_MISMATCH` | `fields:` or `transferFields:` — an offer's, a need-type resource's or a field-by-field supply map — not yielding every required field of the type; a root `env:` map not binding every required field |
| `NEED_FULFILMENT_SOURCE_CONFLICT` / `ERR_NEED_FULFILMENT_SOURCE_CONFLICT` | a need-type resource carrying `fields:` beside `version`, `features` or `parameters` |
| `RESOURCE_INPUT_NEED_TYPE` / `ERR_RESOURCE_INPUT_NEED_TYPE` | a Library `resources:` entry whose kind is a need type |
| `NEED_OPTIONAL_REFERENCED` / `ERR_NEED_OPTIONAL_REFERENCED` | a `!ref` to an optional need at a kind's reference slot |
| `NEED_TYPE_UNVERIFIABLE` | a need type declaring `version` or `features` with no `probe:` |
| `NEED_PROBE_INVALID` | a `probe:` whose inputs or result are not the probe contract |
| `NEED_FORWARD_INCOMPATIBLE` | a need or lease forwarded whole to a need whose version range or features it does not cover |
| `NEED_UNDECLARED` | a `needs:` key at an import or at an application source that the target does not declare |
| `NEED_ENV_NAME_COLLISION` | a need field's bound env name equal to another bound name of the application |
| `REF_FOLLOW_INVALID` | `follows: true` on a slot whose `use` is not `dependency` |
| `ERR_REF_FOLLOW_UNIMPLEMENTED` | a following slot whose controller has no `rebind` |
| `APPLICATION_INPUT_UNDECLARED` | a `variables` / `secrets` / `ports` key at an application source that the target does not declare |
| `APPLICATION_SOURCE_UNRESOLVED` | an application source resolving to nothing |
| `APPLICATION_SOURCE_NOT_APPLICATION` | an application source whose target is not a `Telo.Application` |
| `APPLICATION_SOURCE_CYCLE` | an application reaching itself through start edges |
| `APPLICATION_SOURCE_ANNOTATION_INVALID` | on the definition: the annotated field also carries `x-telo-eval`, or a pointer names no property |
| `NEED_MOVE_SOURCE_DECLARED` | a `movedFrom` entry yielding a path the report still holds |
| `NEED_MOVE_SOURCE_CLAIMED_TWICE` | one former path reached by two report entries |
| `NEED_MOVE_PATH_INVALID` | a `movedFrom` entry that is not a binding path |
| `NEED_MOVE_LIMIT` | more than 16 former paths for one report entry |
| `NEED_MOVE_INERT` | `movedFrom` on a resource or import no binding path passes through; a warning |
| `SUPPLY_OFFER_NAME_DUPLICATE` | two `offers:` entries of one catalog with the same `name` |

Reported at run:

| Code | When |
|---|---|
| `NEED_UNMET` / `ERR_NEED_UNMET` | a required need or a lease with no supplier answer and no env value, a body that failed, a migration target that cannot meet the need, or a fulfilment whose probed version or features do not satisfy it (naming what supplied it, and required against actual); names the need, its type, the declaring module and its bound env names |
| `ERR_NEED_UNVERIFIED` | a probe that could not reach the fulfilment by the deadline; retryable |
| `ERR_NEED_SUPPLIER_INCOMPATIBLE` | a request in a contract generation the supplier does not serve; names both generations |
| `ERR_WORKLOAD_QUOTA_EXCEEDED` | a `ContainerSupply.Run` whose `resources` or volume `size` the session cannot hold |
| `ERR_WORKLOAD_VOLUME_LOST` | a `ContainerSupply.Run` naming a volume the host recorded and no longer finds |
| `ERR_WORKLOAD_VOLUME_IMMUTABLE` | a `ContainerSupply.Run` naming an existing volume with another `size` |
| `ERR_WORKLOAD_HOST_UNAVAILABLE` | a `ContainerSupply.Run` in a supplier given no workload host |
| `ERR_NEED_PROVISIONING` | a need or lease the supplier accepted and had not finished by the deadline; retryable |
| `ERR_NEED_PARTIALLY_SUPPLIED` | some but not all required fields of a need's type set by env |
| `NEED_BINDING_BYPASSED` | a set env name supplying a path the supplier holds a retained binding for; a warning |
| `ERR_NEED_BINDING_CONFLICT` | a binding held at more than one of its current and former paths |
| `NEED_BINDING_REKEYED` | a binding re-keyed from a former path at this resolve; informational |
| `ERR_NEED_BINDING_ORPHANED` / `NEED_BINDING_ORPHANED` | an orphan when the resolve would create a fresh binding of its type; a warning otherwise |
| `ERR_NEED_OFFER_MISSING` | a held binding whose offer entry is no longer listed or now provides another type |
| `ERR_NEED_STORE_UNREADABLE` | a stored record or keyring no configured key opens |
| `ERR_NEED_LEASE_LOST` | a lease the supplier reports gone under a running scope |
| `NEED_REFRESH_FAILED` | a refresh that could not reach the supplier; a warning |
| `ERR_NEED_REVISION_EXPIRED` | a held revision past its `expiresAfter` with no successor adopted |
| `ERR_SUPPLIER_NOT_DECLARED` | a supplier document that is a Library or carries no `supplies:` |
| `ERR_NEED_SUPPLIER_MISMATCH` | a supplier selection differing from the one that made the scope's bindings |
| `ERR_NEED_APPLICATION_DISPLACED` / `NEED_APPLICATION_DISPLACED` | a start, locally or on a runner, that would create a fresh binding of a type a displaced application holds; a warning otherwise |
| `ERR_NEED_BINDING_NOT_HELD` | a migration or release of a path holding no retained binding |
| `ERR_NEED_TRANSFER_UNAVAILABLE` | a transfer asked when none listed moves the need's type, or the named one does not; lists the transfers for the type |
| `ERR_NEED_FREEZE_UNSUPPORTED` | a fenced migration whose source offer has no `freeze:` |
| `ERR_NEED_MIGRATION_IN_PROGRESS` | an action the migration's phase does not allow |
| `ERR_CONTAINER_IMAGE_ABSENT` | `ContainerSupply.Run` given an image the host's local store does not hold |

A field read the type does not declare is the existing `CEL_UNKNOWN_FIELD`, a wrong kind at a consuming slot or at a catalog's `store:` the existing `REFERENCE_KIND_MISMATCH`, and an offer's `freeze:` missing a member a schema violation. The refusals the analyzer and kernel own get rows in the check/run agreement suite; the supplier contract's are pinned in the `supply` module's tests, the workload-host contract's in `supply-container`'s, and the host's in `@telorun/needs-host`'s own tests, with one agreement test per backend.

### Tests

- A test declares a lease in its sequence's `with:` and supplies it to the `App.Instance` it starts with `needs: { <name>: !ref <lease> }`. Each test declaring its own gets its own; an API and its worker share one by taking the same `!ref`.
- The root suite must pass with no container engine installed, so there a need is supplied field by field with literals, by a self-supplied fulfilment, or by an inline `Supply.Catalog` of static offers over the in-memory key/value store. A test whose lease only a container can answer lives under its module's `tests/integration/`.

## Constraints from work not in this plan

- **Grants.** A fulfilled field is the scope of a derived grant — a bound host is outbound access to it, a resolved executable is permission to run it, a library is permission to load it, a directory is write access. So values are delivered only to the module instance that declared the need, no controller reads them from the process environment, and an address is a `Telo.Url` whose `host` and `port` a grant reads without parsing text.
- **Compute estimate.** A co-located fulfilment consumes the application's budget and a remote one does not, which is why an offer states a `footprint`, a bound answer carries it, and the report is extensible. A footprint is an estimate only: what a host enforces is the `resources` it applied to a workload.

## Order of work

Every module adopting new surface — `needs:`, `movedFrom`, `supplies:`, `Telo.Url`, a need-type resource, `probe:` on a need type, `x-telo-need-type`, `x-telo-application-source`, `follows:` on `x-telo-ref` — declares a `requires: telo:` floor on the same change.

1. **Need surface.** `Telo.Url`; `Telo.NeedType` registering a kind; the `needs:` block and its declarations; the three kernel-declared types; reference consumption and field reads; the self-supplied fulfilment; bubbling; whole and field-by-field supply at an import; per-instance bindings; `probe:` with its static refusals, run on a need supplied at an import or self-supplied; the static refusals; `ERR_NEED_UNMET` at load. Tests: a fixture type's probe refuses a literal supply that does not satisfy the need's range; an application supplying an imported library's need with literals runs and asserts the values; a consumer in the same module references an inline self-supplied fulfilment; an unsupplied one fails with `ERR_NEED_UNMET`; a `Telo.Url` written as text and as an object reads the same members.
2. **Started applications.** `x-telo-application-source`, `App.Instance`'s `needs:` with literal supply, and the static input checks. Tests: a root application's own needs supplied by the test that starts it; `NEED_UNDECLARED` and `APPLICATION_INPUT_UNDECLARED` at check, with their boot twins.
3. **Report and env.** The report with its path grammar, `telo needs report`, root `env:` bindings with their refusals and the probe on an env-supplied need, and `movedFrom` with its static refusals and `formerPaths`, preserved by `telo install` / `upgrade` / `publish` when they rewrite `imports:`. CLI surface only, pinned by CLI run tests.
4. **Cache and state directories.** The cache moves to `.telo/cache/`, `.telo/state/` and `TELO_STATE_DIR` appear, every writer beneath `.telo/` is swept onto one of the two, and the deploy docs follow.
5. **Contract and catalog.** The supplier contract as spec, data and check, with the four workload-set messages, per-request generations and `ERR_NEED_SUPPLIER_INCOMPATIBLE`; `Telo.NeedSupplier`; `supplies:`; prepare at every load; resolve before init, with pending; refresh with revisions; leases resolved at context open under a kernel-minted opening id; the probe on supplier answers and leases; the child-start relay; the `supplier:` slots; `KvStore.SealedStore`, `kv-store-sealed` and the sealed in-memory store; `supply` with static offers, named entries and `when:`. Tests: an inline catalog over the in-memory store handed to an `App.Instance`; two instances get distinct bindings; a shared `!ref` gives one; the first of two matching entries answers and a `when:` sends one of two needs elsewhere; a consumer's init reads a sibling lease's fields with no `targets:` entry for the lease; a lease is released when its sequence ends.
6. **Adoption.** `follows:` and `rebind`, `controller-rebind` in the controller protocol, the site classification and `adoption` in the report, the blocked-binding report, the probe on a changed revision, and `rotate:` with its claims. The subjects are a need type, an offer and a following consumer declared in test fixtures. Tests: a rotated field reaches a following consumer inside an imported library with no resource re-created; the same application with one startup read reports `adoption: restart` and changes nothing at rotation.
7. **The host, in the CLI.** `@telorun/needs-host` with its two seams, the file record store, and its own tests; `--supplier`, the default supplier, `supply-local`, `kv-store-file` and the key; scopes and the application record; the host-set messages list and release-retained; the `telo needs` verbs but `migrate`; retention, re-keying, orphans, displaced applications and the supplier mismatch; the drained restart of a blocked workload; provisioning claims; prepare in `telo install`.
8. **Host-run workloads and downloads.** The workload-host contract as spec, data and check; `binding.placement`; `supply-container` over it, volumes included; the host component serving it, with the local container engine as the CLI's substrate and the volume record in the scope; `supply-download`. Offers carry `prepare:`. Integration tests under `tests/integration/` against a need type and container offer declared in fixtures.
9. **Migration.** The host-set message migrate; `Supply.Transfer`, `freeze:` and `transferFields:` on offers, `telo needs migrate` fenced and with `--no-freeze`, the freeze deadline, staged adoption across two local processes, abort, `--to-superseded` and the superseded release; the probe on a successor before the freeze. Tested against a fixture type whose offers hold data, under `tests/integration/` where a container is needed.
10. **Runners.** The runner-core session endpoint and token, the `features.needs` routes, the supplier front serving every admitted telo's workload-set generation, then the docker and k8s backends embedding the host component — each adding its workload substrate and its record store, not a second host — hosting an operator's supplier application and serving the workload-host contract (`features.workloads`) with applied limits, volumes, session quota and orphan reaping; owned scopes released on session deletion and, at boot, for sessions that are gone; relocate for a renamed session application; lease reaping and the drained restart; the local-process backend's `needsStateDir` / `needsScope`.
11. **PostgreSQL.** `Postgres.DatabaseAccess` with its probe; `Postgres.Connection.database` replacing `connectionString`, following, released as a minor with the break described; every in-repo manifest that wrote `connectionString` moved to a need, or to a self-supplied `Postgres.DatabaseAccess` — inline at the `database` slot when used once, its `url` in object form where the manifest composed one from separate variables; `supply-postgres` with a static and a container offer, the container one with `freeze:` and `transferFields:`, and a transfer; integration tests using them, one migrating a binding between two entries.
12. **Docs.** Guides for declaring a need, writing a type and its probe, writing an offer, writing a transfer, running a supplier, serving the workload-host contract, pointing a need at an existing service, migrating a binding, renaming a need and testing an application with needs; the following-slot annotation and `rebind` in the extend docs; the need-type naming convention in the style guide; the docs of every new module and of `app`, `test`, `postgres` and `kv-store`; `oauth-client`'s security doc pointing at the sealed store; the authoring-agent primer; the root and package guides.

The Rust kernel carries no supplier client, so it refuses a module declaring `needs:` or a lease with `ERR_UNSUPPORTED_MANIFEST_FEATURE` until it does; a literal self-supplied fulfilment consumed by reference asks no CEL and no supplier of it. The supplier contract is language-neutral data, as the controller protocol is, so once it carries the client a Rust application is started and supplied by a Node one unchanged. The report reads no CEL, so a kernel with no CEL engine builds it. The Rust side owes one twin of the host component, which gives its CLI the same `telo needs` family and record format.

## Verify

- At the end of each of steps 1, 2 and 5 the root suite holds a passing test that reads a fulfilled need, on a clean checkout with nothing running, and it passes with no container engine installed.
- An application importing a library that needs PostgreSQL, with no `needs:` of its own, boots on a runner whose supplier offers it, with no connection value written anywhere; `telo needs report` lists exactly that one binding.
- One manifest binding `env: { url: DATABASE_URL }` boots both ways: with the variable unset the supplier provisions; with it set the application boots against an empty catalog, and on a path with a held binding it warns `NEED_BINDING_BYPASSED` and leaves the binding listed. With neither a matching offer nor the variable it is refused with `ERR_NEED_UNMET`, naming `DATABASE_URL`, before any resource initializes.
- `telo check` offline refuses: a read of a field the type does not declare; `Postgres.Connection.database` referencing a need of another kind; an offer missing a field; a mistyped need or variable name at an `App.Instance`; an offer whose `prepare:` reads `binding.id`; an offer whose `freeze:` has no `revert`; a catalog whose `store:` is a plain SQL store; a library declaring `resources: { db: { kind: Postgres.DatabaseAccess } }`.
- A kind written outside the repo with `x-telo-application-source` gets the same checks, and an application started by a hundred resources is analysed once.
- An offer writing `url` in object form with a generated password containing `@` and `/` yields a connection that authenticates; a log line reading `resources.database.url.host` is not redacted and one reading the URL's text is.
- A manifest binding `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME` as five variables opens a connection through one inline `Postgres.DatabaseAccess`, and `telo needs report` on it lists nothing.
- Two connections referencing one need get one database; an isolated library imported twice yields two; the studio's reference picker offers the need at `database` with no kind-specific code.
- In one `with:`, a lease and a `Postgres.Connection` referencing it boot with no `targets:` entry for the lease; three leases of one context send one resolve under one opening id, and with two needs held from the same supplier one refresh per period; a module-level lease and two needs produce one prepare and one resolve at load; a `with:` lease no offer matches refuses `telo run` at load with no context opened; an open whose first resolve times out and is retried holds one container; two concurrent runs of one sequence hold two leases and release each by its own opening id; a lease the supplier cannot answer fails with `ERR_NEED_UNMET` and no sibling's init ran.
- An integration suite given `TELO_SUPPLIER` once runs a test whose started application has its need met by that supplier, with nothing about offers written in the test; a test child cannot read a binding of another application in the scope.
- A new way to fulfil a need ships as a module with no release of the telo version line; an application importing only `postgres` has no `supply*` module in its `telo install` closure.
- An offer exported by a module outside the repo, whose `acquire:` invokes a kind that module does not export, provisions through a catalog in another module. Listed first, it answers a need a later entry also matches; reordering, renaming its import alias or inlining it leaves the binding where it is, and removing the entry refuses the next run with `ERR_NEED_OFFER_MISSING` and creates nothing.
- A supplier application with one static offer over `secrets.databaseUrl` boots a library's PostgreSQL need against an existing database; releasing the binding leaves the database untouched; restarting the supplier with a new secret value reaches the application as a new revision.
- `--supplier` naming a Library, or an application without `supplies:`, is refused before the workload loads.
- An `acquire:` outlasting an `App.Instance`'s start deadline fails with `ERR_NEED_PROVISIONING`, and the next run boots on the same `binding.id` with one container; two supplier replicas resolving one pending path run one body; a plain `telo run` waits and boots.
- Renaming an import alias with `movedFrom` on the import keeps the same database, mid-migration included, and logs `NEED_BINDING_REKEYED` once; without it the run is refused with `ERR_NEED_BINDING_ORPHANED` naming both paths, and never boots on an empty database. Removing the entry afterwards boots clean in a scope that has run and is refused in one that has not.
- An `App.Instance` renamed with `metadata.movedFrom` keeps its child's bindings, as does a starter kind written outside the repo; a `Console` resource carrying it warns `NEED_MOVE_INERT`. A library need renamed with `movedFrom`, imported twice isolated, re-keys both bindings. Two same-type needs with their names swapped, each listing the other, is `NEED_MOVE_SOURCE_DECLARED`.
- A need read at one field and a need referenced by `!ref` produce identical report entries and identical resolve answers; a root binding `env:` for one of two required fields is refused at `telo check`.
- The same held, release, migrate and relocate scenario passes through `telo needs …` and through the runner routes against one implementation; `telo run` loads no session server. A local-runner session given `needsStateDir` and `needsScope` sees the database a terminal `telo run --needs-scope <same>` created, and keeps it after the session and the runner stop.
- A runner killed and restarted leaves no binding listed in the supplier's store for its dead sessions. Renaming a session application without relocate is refused before a fresh database is created.
- Releasing an application holding fifty bindings sends one message. A Rust-built host administers a supplier running on a Node kernel.
- Renaming `metadata.name` or moving the checkout keeps every binding, locally and on a runner. Moving the manifest inside the workspace is refused with `ERR_NEED_APPLICATION_DISPLACED` with no database created, and boots on the old one after `telo needs relocate`. Two manifests in one directory with one `metadata.name` get two databases, as does one manifest under two `--needs-scope` names.
- `rm -rf .telo/cache` leaves `telo needs held` unchanged and the next run re-warms and boots on the same bindings.
- `telo run --supplier ops.yaml app.yaml` followed by a run or a `telo needs held` without the flag is refused with `ERR_NEED_SUPPLIER_MISMATCH` naming `ops.yaml`, and provisions nothing.
- In a directory holding a folder named `release`, `telo needs report ./release` reports and `telo needs release ./release` releases; `telo needs held` and `telo needs release` work against a supplier that is not a `Supply.Catalog`.
- After a run binding a `Telo.GeneratedSecret` and a container database, nothing under `.telo/` and no row of an operator's store holds the secret, a derived password or a body result in clear. Flipping one byte of a record, or copying it onto another binding's key, fails the next resolve with `ERR_NEED_STORE_UNREADABLE`. Keys `[k2, k1]` then `[k2]` keep every binding readable across both deploys. A checkout copied to a machine without the key is refused naming `TELO_NEEDS_KEY`.
- A server application whose `Postgres.Connection` sits inside an imported library takes a rotated credential: the listening socket is never closed, a request in flight across the rotation succeeds, no resource is re-created, and the next refresh reports the new revision adopted. The same application with one startup read of `resources.database.url` reports `adoption: restart` with nothing booted, changes nothing at rotation, and is restarted drained.
- An offer whose `rotate:` reads an unchanged external secret produces no new revision across ten refreshes; a `rotate:` killed after its side effect and re-run yields the same `rotation.secret`; a binding with no holder for an hour runs no `rotate:`.
- A migration with a transfer between two entries, under a workload writing throughout, ends with every acknowledged write in the new database and the old one read-only and still held. `--abort` after the freeze leaves the application writing to the old one with no successor held and nothing of the transfer left on it. A `finalize:` outlasting `--freeze-deadline` leaves the application writing to the old fulfilment and the migration resumable.
- Two processes of one application sharing one binding adopt a cutover one after the other, the second only after the first reports the new revision; when the first cannot adopt, the second stays on the old fulfilment and `telo needs held` shows why.
- After cutover a second migration is refused until the superseded release; `--to-superseded` returns the application to its original data with writes succeeding.
- A transfer migration from a static offer is refused with `ERR_NEED_FREEZE_UNSUPPORTED` naming `--no-freeze`, `--transfer` on a catalog with no transfer for the type with `ERR_NEED_TRANSFER_UNAVAILABLE`, and a migration of a lease with `ERR_NEED_BINDING_NOT_HELD`, each leaving `telo needs held` unchanged.
- A restarted pod and a suspended and resumed session return the same database, the same `Telo.GeneratedSecret` value and the same `Telo.DurableDirectory`; a deleted session leaves nothing, mid-migration included. A watch-session edit that adds a need is bound with the pod unchanged. A workload token is refused on every `needs` route.
- An integration test that starts an application needing PostgreSQL passes on a machine with only a container engine; two such tests run concurrently see different databases; after the suite exits no container from it runs, and a test killed mid-run loses its container within the window the supplier stated.
- After `telo install` on an application with a download-fulfilled need, a container-fulfilled need and a `Telo.GeneratedSecret`, `telo needs held` lists nothing, no container runs, and a run with the network off boots. `ContainerSupply.Run` given an image the engine lacks fails with `ERR_CONTAINER_IMAGE_ABSENT` and attempts no pull.
- The Rust `telo` binary on a module declaring `needs:` exits with `ERR_UNSUPPORTED_MANIFEST_FEATURE` naming the block, and runs a module whose only fulfilment is a literal self-supplied one.
- With `DATABASE_URL` pointing at a PostgreSQL 14, an application needing `>=15.0.0` is refused with `ERR_NEED_UNMET` naming `DATABASE_URL`, 14 and the range, before any resource initializes. The same refusal names the entry for a static offer claiming 16 over that server, and the declaration for a self-supplied fulfilment. A server without `pgvector` refuses a need listing it.
- An unreachable address ends as `ERR_NEED_UNVERIFIED` at the deadline, never `ERR_NEED_UNMET`; a need with no `version` and no `features` opens no probe connection.
- `telo check` offline refuses a type declaring `features` with no `probe:`, and a versionless need forwarded to a versioned one.
- A transfer migration to an entry over an unsatisfying server is refused with the source still writable.
- A workload on the previous telo release resolves, refreshes and holds a lease against a supplier built from the current tree, and the reverse. Adding a field to a resolve answer changes no generation. A kernel build contains no sender of a host-set message.
- A supplier that predates migrate answers `telo needs held` and `telo needs release`, and refuses `telo needs migrate` naming the generation, not with a transport error.
- A k8s session with a container-fulfilled need shows a second pod carrying the runner's managed-by label, admitted by the session's network policy, with the requested limits set. Deleting the session removes that pod with the supplier process stopped, and a runner restarted mid-session leaves no such pod after boot.
- A `ContainerSupply.Run` whose `resources` exceed the session's remainder refuses with `ERR_NEED_UNMET` and creates nothing; a body passing another binding's placement is refused by the host; an inline catalog in a `supplier:` slot invoking `Run` fails with `ERR_WORKLOAD_HOST_UNAVAILABLE`.
- Killing a container-fulfilled database's pod on k8s, or removing its container locally, and running the application again returns the same rows. An offer that removes its workload while unheld and runs it at the next resolve keeps its data.
- Deleting a volume out of band refuses the next run with `ERR_NEED_UNMET` carrying `ERR_WORKLOAD_VOLUME_LOST` and creates nothing. `telo needs release` leaves no volume behind; a suspended session keeps its volume; a volume `size` beyond the session's remainder is refused and creates nothing.
- The same container offer, unedited, provisions under the CLI, the docker runner and the k8s runner.
- No fulfilled value appears in either pod spec of a k8s session.

## Worked example

One library needs a PostgreSQL database. The same application then runs on Telo Cloud against a shared CloudNativePG cluster, against a database its author names by env, and against an Aurora cluster and database name its operator picks — with no change to the library. Imports are abbreviated to the ones each part is about. `PostgresSupply.CreateDatabase`, `PostgresSupply.DropDatabase` and `PostgresSupply.SetReadOnly` stand for the kinds `supply-postgres` gives an offer's bodies, and `AwsAurora` for a vendor's module; neither is specified above.

### The library and the application

The library declares the need and consumes it. It names no offer, image or address.

```yaml
kind: Telo.Library
metadata: { name: Orders, version: 1.0.0 }
requires: { telo: ">=0.120.0" }
imports:
  Postgres: oci://ghcr.io/telorun/postgres@0.30.0
needs:
  database:
    kind: Postgres.DatabaseAccess
    version: ">=15.0.0"
    features: [pgvector]
---
kind: Postgres.Connection
metadata: { name: db }
database: !ref database
```

An application that only uses the library writes nothing about the database. The need bubbles to whoever starts it.

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.0.0 }
imports:
  Orders: ./orders
```

`telo needs report ./shop` lists one binding, `Orders.database`, of type `Postgres.DatabaseAccess`, `adoption: live`, with no env name.

### Overriding as the application's author

The author opens an env door by declaring a need of the application's own and forwarding it. With `DATABASE_URL` set the application boots on that database and no supplier is asked; unset, the supplier answers the same binding, now at the path `database`. Either way the kernel runs `Postgres.DatabaseAccess`'s probe before anything initializes, so a `DATABASE_URL` naming a PostgreSQL 14, or one without pgvector, is `ERR_NEED_UNMET` naming the variable.

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.1.0 }
requires: { telo: ">=0.120.0" }
imports:
  Postgres: oci://ghcr.io/telorun/postgres@0.30.0
  Orders:
    source: ./orders
    needs:
      database: !ref database
needs:
  database:
    kind: Postgres.DatabaseAccess
    version: ">=15.0.0"
    features: [pgvector]
    env: { url: DATABASE_URL }
    movedFrom: [Orders.database]
```

`movedFrom` is what keeps a database already bound at `Orders.database`; without it the next run is refused with `ERR_NEED_BINDING_ORPHANED`. It is deleted once every scope the application runs in has run this version.

An author who wants no host involvement at all supplies the fields instead, and the need leaves the report:

```yaml
imports:
  Orders:
    source: ./orders
    needs:
      database:
        url:
          scheme: postgres
          host: !cel "variables.dbHost"
          port: !cel "variables.dbPort"
          user: !cel "variables.dbUser"
          password: !cel "secrets.dbPassword"
          path: !interpolate "/${{ variables.dbName }}"
```

### Telo Cloud: a database per binding in one CloudNativePG cluster

The cloud's runner hosts this supplier application. Each binding gets its own database and role inside the one cluster the platform runs; the cluster's superuser credential stays in the supplier and only `fields:` reaches the workload.

```yaml
kind: Telo.Application
metadata: { name: CloudSupplier, version: 1.0.0 }
requires: { telo: ">=0.120.0" }
imports:
  Postgres: oci://ghcr.io/telorun/postgres@0.30.0
  Supply: oci://ghcr.io/telorun/supply@0.1.0
  PostgresSupply: oci://ghcr.io/telorun/supply-postgres@0.1.0
  KvStoreSql: oci://ghcr.io/telorun/kv-store-sql@0.9.0
  KvStoreSealed: oci://ghcr.io/telorun/kv-store-sealed@0.1.0
variables:
  clusterHost: { env: CNPG_RW_HOST, type: string }           # <cluster>-rw.<namespace>.svc
secrets:
  superuserUrl: { env: CNPG_SUPERUSER_URL, type: string, x-telo-type: Telo.Url }
  sealKey: { env: SUPPLY_SEAL_KEY, type: string, x-telo-type: Telo.Bytes }
supplies: !ref catalog
---
kind: Postgres.Connection
metadata: { name: cluster }
database:
  kind: Postgres.DatabaseAccess
  fields: { url: !cel "secrets.superuserUrl" }
---
kind: Supply.Offer
metadata: { name: clusterDatabase }
provides: Postgres.DatabaseAccess
version: 16.4.0
features: [pgvector]
acquire:
  - name: database
    invoke: { kind: PostgresSupply.CreateDatabase, server: !ref cluster }
    inputs:
      name: !interpolate "app_${{ binding.id }}"
      owner: !interpolate "app_${{ binding.id }}"
      password: !cel "binding.secret"
      extensions: !cel "'pgvector' in binding.features ? ['vector'] : []"
fields:
  url:
    scheme: postgres
    host: !cel "variables.clusterHost"
    port: 5432
    user: !interpolate "app_${{ binding.id }}"
    password: !cel "binding.secret"
    path: !interpolate "/app_${{ binding.id }}"
freeze:
  apply:
    - invoke: { kind: PostgresSupply.SetReadOnly, server: !ref cluster }
      inputs: { name: !interpolate "app_${{ binding.id }}", readOnly: true }
  revert:
    - invoke: { kind: PostgresSupply.SetReadOnly, server: !ref cluster }
      inputs: { name: !interpolate "app_${{ binding.id }}", readOnly: false }
release:
  - invoke: { kind: PostgresSupply.DropDatabase, server: !ref cluster }
    inputs: { name: !interpolate "app_${{ binding.id }}" }
---
kind: Supply.Catalog
metadata: { name: catalog }
store:
  kind: KvStoreSealed.Store
  store: { kind: KvStoreSql.Store, connection: !ref cluster }
  keys:
    - { id: k1, key: !cel "secrets.sealKey" }
offers:
  - name: cluster
    offer: !ref clusterDatabase
transfers:
  - !ref PostgresSupply.dumpRestore
```

What happens to the unchanged `Shop` 1.0.0 on a session:

1. The runner gives the workload `TELO_SUPPLIER_URL` and a token for this session and application.
2. Before any resource initializes, the kernel sends prepare, then resolve, with the report's one entry. The entry `cluster` matches; `acquire:` creates database and role `app_<binding.id>` under a claim.
3. The answer is bound: the `url`, a `revision`, and a `refreshAfter`. The kernel probes it against `>=15.0.0` and `pgvector`, then `Postgres.Connection` opens on it.
4. A restarted pod or a resumed session resolves to the same binding and the same database. Deleting the session releases its scope with one release-retained, which runs `release:` and drops it.

### An operator's own supplier: a chosen Aurora cluster and database name

Whoever operates the application — on their own machine with `--supplier`, or on a runner they run — imports the vendor's module and says which cluster and which database name. The vendor's offer does the rest.

```yaml
kind: Telo.Application
metadata: { name: ShopSupplier, version: 1.0.0 }
requires: { telo: ">=0.120.0" }
imports:
  Supply: oci://ghcr.io/telorun/supply@0.1.0
  PostgresSupply: oci://ghcr.io/telorun/supply-postgres@0.1.0
  KvStoreSql: oci://ghcr.io/telorun/kv-store-sql@0.9.0
  KvStoreSealed: oci://ghcr.io/telorun/kv-store-sealed@0.1.0
  ShopAurora:
    source: oci://ghcr.io/example/aws-aurora-supply@2.3.0
    variables:
      region: eu-central-1
      cluster: !cel "variables.auroraCluster"
      database: !cel "variables.auroraDatabase"
    secrets:
      accessKeyId: !cel "secrets.awsAccessKeyId"
      secretAccessKey: !cel "secrets.awsSecretAccessKey"
variables:
  auroraCluster: { env: AURORA_CLUSTER, type: string }      # shop-prod
  auroraDatabase: { env: AURORA_DATABASE, type: string }    # orders
secrets:
  awsAccessKeyId: { env: AWS_ACCESS_KEY_ID, type: string }
  awsSecretAccessKey: { env: AWS_SECRET_ACCESS_KEY, type: string }
  sealKey: { env: SUPPLY_SEAL_KEY, type: string, x-telo-type: Telo.Bytes }
supplies: !ref catalog
---
kind: Supply.Catalog
metadata: { name: catalog }
store: !ref bindings          # a KvStoreSealed.Store, as above
offers:
  - name: ordersAurora
    offer: !ref ShopAurora.database
    when: !cel "need.path == 'Orders.database'"
  - name: container
    offer: !ref PostgresSupply.container
transfers:
  - !ref PostgresSupply.dumpRestore
```

- `Orders.database` is answered by `ordersAurora`; any other PostgreSQL need falls through to a local container.
- A second Aurora database is a second import of the vendor module under another alias, with its own `cluster` and `database`, and a second entry.
- A database that needs no vendor module at all is a static offer over the operator's own secret, in place of the import:

```yaml
kind: Supply.Offer
metadata: { name: existingOrders }
provides: Postgres.DatabaseAccess
version: 16.4.0
features: [pgvector]
fields:
  url: !cel "secrets.ordersUrl"
```

Inside the vendor's module the offer is ordinary: its bodies invoke the vendor's own unexported kinds, and a short-lived credential is a `rotate:` whose lifetime is data.

```yaml
kind: Supply.Offer
metadata: { name: database }
provides: Postgres.DatabaseAccess
version: 16.4.0
features: [pgvector]
acquire:
  - name: cluster
    invoke: { kind: Self.DescribeCluster }
    inputs: { cluster: !cel "variables.cluster" }
  - name: role
    invoke: { kind: Self.EnsureIamRole }
    inputs:
      cluster: !cel "variables.cluster"
      database: !cel "variables.database"
      role: !interpolate "telo_${{ binding.id }}"
rotate:
  - name: token
    invoke: { kind: Self.AuthToken }
    inputs:
      endpoint: !cel "steps.cluster.result.endpoint"
      role: !interpolate "telo_${{ binding.id }}"
rotateAfter: !cel "rotated.token.result.lifetime / 2"
expiresAfter: !cel "rotated.token.result.lifetime"
fields:
  url:
    scheme: postgres
    host: !cel "steps.cluster.result.endpoint"
    port: !cel "steps.cluster.result.port"
    user: !interpolate "telo_${{ binding.id }}"
    password: !cel "rotated.token.result.token"
    path: !interpolate "/${{ variables.database }}"
    query: { sslmode: require }
```

Every refresh after `rotateAfter` runs `rotate:` and answers `changed` with a new `revision`. `Postgres.Connection.database` follows, so the connection rebinds in place and no request is dropped.

### Running it, and moving between offers

```
telo run --supplier ./ops/supplier.yaml ./shop
telo needs held ./shop
telo needs migrate ./shop --need Orders.database --to container --transfer
telo needs release ./shop --need Orders.database --superseded
```

- The first run binds `Orders.database` through `ordersAurora`. The scope records `./ops/supplier.yaml`, so a later run without the flag is `ERR_NEED_SUPPLIER_MISMATCH`.
- `held` shows the binding as `bound`, made by `ordersAurora`, with its `binding.id` and revision and no value.
- The migration acquires a container database as the successor and copies while Aurora serves. The vendor's offer here declares no `freeze:`, so the command is refused with `ERR_NEED_FREEZE_UNSUPPORTED` until `--no-freeze` is added and the operator has stopped writes; from the `cluster` offer of the previous section it would be fenced and lose nothing.
- After cutover the running `Shop` adopts the successor at its next refresh. The Aurora fulfilment stays held as superseded until the last command ends it.
