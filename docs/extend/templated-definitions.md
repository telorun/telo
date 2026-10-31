---
sidebar_label: Templated Definitions
slug: /extend/templated-definitions
description: Define a new resource kind without writing a controller — compose existing kinds declaratively with a dispatch body (resources, invoke/provide/run/mount, targets, inputs, result).
---

# Templated definitions

A `Telo.Definition` does not always need a controller. When your new kind is a **composition of kinds that already exist**, you can build it entirely in YAML: declare the internal resources it wires up, and delegate its capability method to one of them. There is no code, the kind stays fully visual in the editor, and it remains statically analyzable.

This is the *templated* form of a definition. It is the counterpart to the controller-backed form in [Authoring a Module](/extend/authoring-a-module): same `Telo.Definition` document, but instead of `controllers:` pointing at a package, a **dispatch body** describes how to assemble and run the instance.

## Templated vs. controller-backed

| Reach for a template when… | Reach for a controller when… |
|---|---|
| the behaviour is a composition of existing kinds (a SQL query, an HTTP call, a cache lookup) | you need a Node/Rust API the kernel doesn't expose yet |
| it's reusable and you want it type-safe at the manifest level | the logic is novel runtime behaviour, not a wiring of existing kinds |
| you want it editable and analyzable without shipping a package | you need imperative control the template engine can't express |

Templates are the preferred extension path whenever they fit — see the `JS.Script`-is-a-last-resort guidance in `CLAUDE.md`: before writing code, check whether the work is a composition that belongs in a generic templated kind.

## Anatomy

A templated definition omits `controllers:` and instead supplies:

| Field | Role |
|---|---|
| `capability` | still required — the lifecycle role the instance fulfils (`Telo.Invocable`, `Telo.Provider`, `Telo.Runnable`, `Telo.Mount`) |
| `schema` | the kind's config; `self` is typed from it |
| `inputType` / `outputType` | the invocation contract (Invocable / Runnable) |
| `resources` | internal sub-resources instantiated per outer instance — the kinds the template composes |
| `invoke:` / `provide:` / `run:` / `mount:` | the **dispatch target** — a `!ref` to the internal resource that fulfils the capability |
| `targets:` | Service / Runnable only, instead of `run:` — the internal resources the instance **starts**, in order, when it runs (`!ref` entries, inline declarations, or repeats and choices emitting them) |
| `inputs` | top-level sibling — the values passed *to* the dispatch target |
| `result` | top-level sibling — post-call mapping applied to the target's output |
| `extends` | the `Telo.Abstract` this kind implements (optional) |

The dispatch field, `inputs`, and `result` are **top-level siblings** on the definition — the same `{ name, inputs, invoke }` factoring used by `Run.Sequence` steps.

A body is not fixed text: `!for-each` turns the consumer's list or map into list items, map entries, named resources or steps, and `!if` / `!switch` choose a value, an item or a resource's kind from what the consumer wrote ([below](#repeats-and-choices-inside-a-body)).

## Invocable template

Compose a `Sql.Query` into a reusable `Read` kind. Each `Read` instance owns its own query resource (named from `self.name` so instances don't collide), delegates `invoke()` to it, and feeds it SQL built from the instance's config and the caller's inputs:

```yaml
kind: Telo.Definition
metadata:
  name: Read
capability: Telo.Invocable
schema:
  type: object
  required: [connection, table]
  properties:
    connection:
      x-telo-ref: Sql.Connection
    table:
      type: string
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      filters: { type: object, additionalProperties: true }
    required: [filters]
resources:
  - kind: Sql.Query
    metadata: { name: query }
    connection: !cel "self.connection"
invoke: !ref query
inputs:
  sql: !cel "'SELECT * FROM ' + self.table + (keys(inputs.filters).size() > 0 ? ' WHERE ' + join(keys(inputs.filters).map(k, k + ' = ?'), ' AND ') : '')"
  bindings: !cel "keys(inputs.filters).map(k, inputs.filters[k])"
```

- `resources` declares the internal `Sql.Query`, under a **literal** name. A name composed from `self` (`!cel "self.name + '-query'"`) is refused — `TEMPLATE_ENTRY_NAME_DYNAMIC` at `telo check`, `ERR_TEMPLATE_ENTRY_NAME_DYNAMIC` at the kernel. Every instance of a template owns its children in a child context of its own, so two instances never collide on a literal name and a per-instance suffix buys nothing; what it costs is that a `!ref` is looked up verbatim, so a CEL-named entry is one nothing can name.
- `invoke` names it with a `!ref`, the same spelling every other reference uses. A `!ref` naming no entry is `TEMPLATE_DISPATCH_UNKNOWN`. A bare string or a `{ kind, name }` object there is the deprecated spelling: `telo check` warns `DEPRECATED_TEMPLATE_DISPATCH_FORM` and the kernel still runs it, because published modules carry it — write `!ref` instead.
- Reference slots **inside** an entry follow the same rule: `!ref` or an inline declaration, naming a sibling entry or a resource of the declaring module (`TEMPLATE_REF_UNKNOWN` otherwise).
- A reference the **instance** holds reaches an entry only through a bare `!cel "self.<path>"`, which forwards the value untouched — a single slot (`connection: !cel "self.connection"`) or a whole value holding several (`routes: !cel "self.routes"`, where each route's `handler` is a reference the instance declared). Any other expression is evaluated by CEL and yields data, so a computed value at or above a reference slot is `REF_SLOT_COMPUTED` — and `ERR_REF_SLOT_COMPUTED` at boot, refused before the body is expanded, which is what reaches you when the body belongs to a published dependency your own `telo check` says nothing about: to forward routes, declare them on the kind already shaped as the router expects rather than assembling them with `map`. The same rule holds outside a body, at a resource field the kind evaluates at creation.
- A forwarded value is **checked as the entry kind's own field**. At boot the entry receives it verbatim, so `telo check` validates what each consumer writes there exactly as it would a resource of the entry's kind: its schema (inheritance and `x-telo-schema-from` resolved), its reference slots and their `inputs:`, and the CEL inside it in the entry's contexts — `request.*` in a route's `inputs:`, `result.*` in its `returns:` — unless your kind marks the path `x-telo-eval: compile`, which evaluates it before it is forwarded. Each finding is reported on the consumer's own line (`workflows[0].returns[0].status`), under its usual code. So your kind's `schema:` declares only what it adds — titles, a field it requires that the entry does not — and never restates the entry's constraints or `x-telo-context` blocks. The one thing it must keep is every **reference slot** under the forwarded value: a reference is resolved where the consumer declared it only when your kind's schema marks the slot `x-telo-ref`. A declaration that disagrees with the entry's field is `TEMPLATE_FORWARD_INCOMPATIBLE` at your kind.
- `inputs` is what gets passed to the `Sql.Query`. Inside it, CEL sees both `self` and `inputs` (the caller's arguments to `Read`). The map is checked against the dispatch target's declared `inputType` like any call site: a literal that does not satisfy it is `TEMPLATE_TARGET_MISMATCH`, and a `!cel` whose type does not fit the argument — a string into an `integer`, a `self` field declared nullable into an argument that takes no null — is `CEL_TYPE_ERROR` at that argument, where it would otherwise fail at dispatch with `ERR_INPUT_INVALID`.

## Provider template

A provider composes a source kind and shapes its output. `provide()` takes no caller arguments, so the body sees only `self`. The top-level `result` maps the target's output into the shape required by the `extends`-declared abstract:

```yaml
kind: Telo.Definition
metadata:
  name: TokenProvider
capability: Telo.Provider
extends: Auth.Credential
schema:
  type: object
  required: [secret]
  properties:
    secret: { type: string }
resources:
  - kind: JavaScript.Script
    metadata: { name: source }
    inputType: { type: object, additionalProperties: true }
    outputType: { type: object, additionalProperties: true }
    code: |
      function main(input) { return { raw: input.value } }
provide: !ref source
inputs:
  value: !cel "self.secret"
result:
  token: !cel "'bearer ' + result.raw"
```

- `provide` names the dispatch target.
- `inputs` feeds it (`self` only — no `inputs` variable for providers).
- `result` rewrites the target's output. Inside `result`, CEL sees `result`, typed from the dispatch target's `outputType`; the produced value is validated against the `outputType` of the abstract this kind `extends`.

## Mount template

A `Telo.Mount` template declares an internal mountable surface (typically an `Http.Api`) plus any handlers it needs, then names the surface with `mount:`. `modules/crud` is the canonical example — `Crud.Resource` builds four SQL handlers and one `Http.Api`, all from `self`. Its list route answers with an envelope — one page of rows, the count of every match and the cursor of the next page — rather than a bare array:

```yaml
kind: Telo.Definition
metadata:
  name: Resource
capability: Telo.Mount
schema:
  type: object
  required: [connection, table]
  properties:
    connection: { x-telo-ref: Sql.Connection }
    table: { type: string }
resources:
  - kind: Self.Reader          # an internal handler kind of the same library
    metadata: { name: reader }
    connection: !cel "self.connection"
    table: !cel "self.table"
  - kind: Http.Api
    metadata: { name: api }
    routes:
      - request: { method: GET, path: / }
        handler: !ref reader
        returns:
          - status: 200
            content:
              application/json:
                body: !cel "result"   # { rows, total, next }
mount: !ref api
```

See [`modules/crud/telo.yaml`](https://github.com/telorun/telo/blob/main/modules/crud/telo.yaml) for the full CRUD surface.

## Starting several entries — `targets:`

`run:` forwards the instance's one `run()` to one entry. A kind that has more
than one thing to start — a server and the poller beside it, a schema migration
before the server that reads the table — lists them in `targets:` instead, the
template's counterpart to an Application's boot sequence:

```yaml
kind: Telo.Definition
metadata:
  name: App
capability: Telo.Service
schema: { … }
resources:
  - kind: DurableLocal.Resumer
    metadata: { name: resumer }
    workflow: !ref process
  - kind: Http.Server
    metadata: { name: server }
    listen:
      port: !cel "self.port"
    mounts: [ … ]
targets:
  - !ref resumer
  - !ref server
```

When an instance runs, each target is started in order through the kernel's
run path — traced, marked started, and holding what its own `run()` allocated
(a listening socket, a kernel hold) for as long as the instance lives. A target
that fails stops the ones after it.

- Each item is `!ref <entry>` naming a `resources:` entry, an inline
  declaration of a `Telo.Service` or `Telo.Runnable` kind — created with the
  body's entries and started like one — or an `!if` / `!switch` / `!for-each`
  choosing or emitting either (see below). Anything else is
  `TEMPLATE_TARGETS_INVALID`, a name matching no entry is
  `TEMPLATE_TARGET_UNKNOWN`, and an inline or emitted declaration of a kind that
  is never run is `TEMPLATE_TARGETS_CAPABILITY`.
- Only on a `Telo.Service` or `Telo.Runnable` definition
  (`TEMPLATE_TARGETS_CAPABILITY`) — an invocable, provider or mount is never run,
  so nothing would start its targets.
- Not beside `run:` (`TEMPLATE_TARGETS_WITH_RUN`); a single entry is
  `targets: [!ref <entry>]`.

Each refusal is reported by `telo check` at the definition and, for a
dependency's definition the consumer's check does not read, by the kernel when
the definition is registered (`ERR_TEMPLATE_TARGETS_WITH_RUN`, …). A module
writing `targets:` on a definition declares `requires: telo: ">=0.96.0"`.

## Repeats and choices inside a body

A body's lists, mappings and `resources:` entries may be decided by what the
consumer wrote. `!for-each` turns a consumer's collection into list items or map
entries; `!if` and `!switch` choose a value, an item, or the kind behind a
named entry.

```yaml
resources:
  - kind: Http.Api
    metadata: { name: api }
    routes:
      - !for-each
        in: !cel "self.hooks"
        as: hook
        emit:
          - request: { path: !interpolate "/hooks/${{ hook.key }}", method: POST }
            inputs: { event: !cel "request.body", source: !cel "hook.key" }
            handler: !cel "hook.value.handler"
            returns: [{ status: 202 }]
          - request: { path: !interpolate "/hooks/${{ hook.key }}", method: GET }
            handler: !cel "hook.value.status"
            returns: [{ status: 200 }]
  - kind: SQLite.Table
    metadata: { name: records }
    columns:
      id: { type: integer, primaryKey: true }
      ...: !for-each
        in: !cel "self.fields"
        key: !cel "each.key"
        emit: { type: !cel "each.value.type" }
targets:
  - kind: Http.Server
    listen: { port: !cel "self.port" }
    mounts:
      - { path: /, mount: !cel "self.api" }
      - !if
        if: !cel "self.adminPort == self.port"
        then: { path: /admin, mount: !cel "self.admin" }
  - !if
    if: !cel "self.adminPort != self.port"
    then:
      kind: Http.Server
      listen: { port: !cel "self.adminPort" }
      mounts: [{ path: /, mount: !cel "self.admin" }]
```

- **The source** (`in:`) is a bare `self.<path>` or `<binding>.value.<path>`
  whose schema is a list or a map; the consumer writes it literally, so every
  element is known before boot. A computed source is `REPEAT_COMPUTED` at the
  consumer's key, a map key that is an integer (`"2024"`) `REPEAT_NUMERIC_KEY`.
- **The binding** is `each`, or the name `as:` gives: a record of `value` (the
  element, typed from the source), `index`, and `key` for a map source only. It
  is in scope in every expression the `emit:` holds, including those the
  entry's own kind evaluates per call. A bare `<binding>.value.<path>` hands the
  consumer's value through untouched, references included, exactly as a bare
  `self.<path>` does; anything else is CEL, whose values are data. A name an
  enclosing loop, a CEL global or the emitted kind already binds is
  `BINDING_NAME_RESERVED`.
- **Numbers read as the schema declares them.** In an expression, `self` and a
  binding's `value` hold each declared `integer` as an integer and each `number`
  as a double, whatever the consumer's YAML looked like, so `self.factor * 10`
  and `each.value.factor * 10` run as `telo check` types them; a value in a
  collection with no declared type follows the rule a pure step's literal
  `value:` does (an integral number is an integer). A bare `self.<path>` or
  `<binding>.value.<path>` handed to a field is not read this way: the entry's
  controller receives the value as the consumer wrote it.
- **What `emit:` is** depends on where the repeat stands: in a list, the items
  each element contributes (a sequence for several, in emit order per element);
  under a `...` key, the value of the one entry each element contributes, keyed
  by `key:`, at the place the `...` is written beside literal entries. Two
  elements emitting one key, or a key a literal entry holds, are
  `REPEAT_KEY_DUPLICATE` at the consumer's element.
- **A choice** is `!if` (`if:` a boolean, `then:`, optional `else:`) or `!switch`
  (`switch:` a string, integer or boolean, `cases:`, optional `default:`); a
  `!switch` with no `default:` must cover its selector's domain. Where no branch
  is chosen it contributes **nothing to its container** — no list item, no
  field or map entry, no declaration — and a field the schema requires is then
  a violation. It reads `self`, a loop's binding, a declaration a reference names
  (as written, its kind's defaults filled, in the consumer's own module only),
  `module.<field>` or the module's own inputs. At a `resources:` entry the tag
  carries the entry's `metadata` and each branch is one unnamed declaration, so
  the entry's name is the same whatever is chosen. A value the consumer
  computes, or one read across a reference into another module, is
  `BRANCH_UNDECIDABLE` at the consumer's value.

```yaml
resources:
  - !switch
    metadata: { name: connection }
    switch: !cel "self.database.engine"     # an `enum: [sqlite, postgres]` field
    cases:
      sqlite: { kind: SQLite.Connection, file: !cel "self.database.file" }
      postgres: { kind: Postgres.Connection, access: !cel "self.database.access" }
```

The consumer's `engine` picks the kind behind `connection`; every other entry
refers to `connection` alone. Choices outside a body, over the application's own
inputs, are the subject of [Choosing by configuration](/learn/choosing-by-configuration).

`telo check` checks a definition with **no consumer**: every branch, and every
`emit:` over a representative element, against the kind its position holds. A
choice over a closed domain (`enum`, `const`, boolean) is checked for
exhaustiveness and reachability at the definition; a comparison of open values
(`self.adminPort == self.port`) is decided per consumer, and two conditions
written as the same comparison, or its negation, always take matching branches —
so the `admin` server above exists exactly when the second `targets:` item is
chosen. A finding that arises only for some values says for which:
`(when self.mode is b)`, `(when 'self.adminPort == self.port' is false)`. Each
consumer then expands the body by what it wrote, and what it forwards into an
entry is checked as that entry's field, at the consumer's own path.

**At run, each instance expands the body when it initializes — by the same
expansion `telo check` runs for each consumer.** Its choices are decided from
the instance as its author wrote it — a reference crossed is read through the
declaration it names, defaults filled, never through what that resource
publishes — and from the library's own inputs; its repeats iterate the
collections it holds, in written order. What the body starts is computed from
the expanded `targets:`: an inline declaration, or one an element emits, is
created with the body's entries and started in order, one per element. An
expression an emitted item holds keeps its loop's binding wherever it is later
evaluated, and an inline declaration inside an emitted item is created once per
element, named by where it is written and the element it was emitted for. What
the expansion refuses (a choice reading anything nothing before boot decides, a
computed source, an integer-like key, a `targets:` list naming no entry in this
instance) is refused together, under the codes `telo check` reports, as one
failed start. A dependency's own declaration of another library's templated
kind is expanded the same way, its choices decided through the import's bindings,
and refused at the `imports:` entry that brings it in.

### Families — one list into N named resources

A `!for-each` at a `resources:` entry (or an `x-telo-scope` member) declares a
**family**: its tag carries the `metadata` a plain entry would, and `emit:` is one
unnamed declaration — or an `!if` / `!switch` / nested `!for-each` emitting one.
Each element of the source gets one **member**.

```yaml
resources:
  - !for-each
    metadata: { name: crons }
    in: !cel "self.jobs"
    emit:
      kind: Scheduler.Cron
      cron: !cel "each.value.cron"
      invoke: !cel "each.value.invoke"
targets:
  - !for-each
    in: !cel "self.jobs"
    emit: !ref crons[each.key]
```

- **The family is one name**: judged once, beside the body's other entries (an
  entry of the same name is `DUPLICATE_RESOURCE_NAME`). It is never exported.
- **A member is referenced by binding**: `!ref crons[each.key]` (map source) or
  `!ref crons[each.index]` (list source), one index per family depth
  (`!ref ops[table.key][op.key]`). Each binding must be a loop around the
  reference iterating the family's own source at that depth — the outermost the
  same source, a deeper one iterating the previous binding along the family's
  own path — so a member's existence is proven at the definition, never per
  consumer. `!ref crons` with no index, an index on a name that is no family, the
  wrong depth, a binding out of scope or over another source, and `key` over a
  list (or `index` over a map) are `REF_MEMBER_INVALID`. Inside a flow collection
  quote it: `{ store: !ref "stores[each.key]" }`.
- **Every element has a member**: a sequence in a family's `emit:`, and an `!if`
  there with no `else:`, are `REPEAT_EMIT_INVALID`. To drop elements, use an
  unnamed repeat at a list position instead.
- **A member's identity** is the family's name and its element's index path as
  CEL index literals — `crons['nightlyReport']`, `stores[0]`,
  `ops['users']['list']`. That is its name in the instance's registry, its
  `telo.resource.name` on spans and in kernel events, and how messages name it.
  Keyed by the element, never by its position, so adding an element leaves every
  other member's name unchanged.
- **After a reload a member keeps its name.** An instance no `targets:` chain
  holds is re-created in place by `kernel.reconcile()`; one a `targets:` chain
  holds is answered `restartRequired`, and the rebuild expands it again. On both
  routes a member is named by its family and its element's key (`crons['a']`),
  so inserting or removing an element leaves every other member's name
  unchanged.

An indexed `!ref` outside a template body has no family to name and is
`REF_MEMBER_INVALID`.

### Step repeats

A `!for-each` in a list of steps emits steps. Unnamed, its steps run in source
order and publish no result. Named, it joins the body's step names:

```yaml
steps:
  - !for-each
    name: runs
    in: !cel "self.jobs"
    emit:
      invoke: !ref tasks[each.key]
  - !for-each
    name: totals
    in: !cel "self.jobs"
    emit:
      value: !cel "steps.runs[each.key].result.scaled"
```

`steps.runs` is a map from element key to `{ result }`, typed from the emitted
step's result — `steps.runs[each.key].result` reads the result of the step
emitted for that element. An emitted step carries no `name:` (an emitted step
naming itself, a sequence in a named repeat's `emit:`, and a nested `!for-each`
there are `REPEAT_EMIT_INVALID`): the expansion gives each one its identity
instead — `runs['nightlyReport']`, keyed by element — and a durable run journals
it under that key (`steps/runs['nightlyReport']`), so a resumed run replays each
element by its key whatever was added around it. A list source's results are a
map with int keys, which the analysis leaves open.

## A `resources:` entry is a declaration of its own kind

Write each entry exactly as you would write the same resource at the top level. Its CEL is resolved through **that kind's** annotations — its `x-telo-context` regions, its step body, its error branches — so every name the kind binds is in scope where it binds it:

```yaml
resources:
  - kind: Run.Sequence
    metadata: { name: body }
    inputType:
      kind: Telo.JsonSchema
      schema:
        type: object
        properties: { q: { type: string } }
    steps:
      - name: rows
        invoke: !ref query
        inputs:
          bindings:
            - !cel "inputs.q"          # the SEQUENCE's own arguments
  - kind: Run.Projection
    metadata: { name: labels }
    collection: !cel "inputs.rows"
    steps:
      - name: label
        value: !cel "item.body"        # the ITERATION's element
```

An entry is checked as that resource would be: against its kind's schema, with every `!ref` — including a step's `invoke:` — naming a sibling entry or a resource of the declaring module, and no two entries under one name. A resource used once inside an entry can be declared inline where it is used (a route's `handler: { kind: Run.Sequence, … }`); it is created with the rest of the body, and its CEL is typed by its own kind.

A body is not limited to one dispatch. `inputs` inside a nested body types from **that entry's own `inputType:`**, never the enclosing definition's — the template reaches its body through a mapping free to rename or narrow, so typing against the outer contract would accept names the body never receives.

Which nodes survive the template's `init()` is decided by the nested kind too: a field it marks `x-telo-eval: runtime`, or one under a CEL-bearing region, is left compiled for its own controller to evaluate. Everything else is resolved once against `self`.

## CEL scopes inside a template

| Variable | Typed from | Available in |
|---|---|---|
| `self` | this definition's `schema` | everywhere — `resources` (at any depth), `inputs`, `result`, and CEL in `schema` |
| `inputs` | the enclosing `inputType` at top-level `inputs:`; a nested entry's OWN `inputType` inside it | top-level `inputs` — **Invocable / Runnable only** — and wherever the nested kind binds it |
| `result` | the dispatch target's `outputType` | top-level `result` |
| `resources` | the defining module's resources, plus this body's own entries | everywhere in the body — see below |
| whatever the nested kind binds | that kind's own annotations | inside the entry that declares it — `item` / `index` in an iteration, `request` in a route, `error` in a `catch:` |

`self` may be mixed with a call-time name in one expression. A field the instance leaves out reads as its schema `default:` through `self`.

**`resources` inside a body is the module's record with the body's own entries over it.** Every entry is readable by name from every CEL site of the body — the entries' own fields, `inputs:` and `result:` — so a step reads `resources.server.url`, or `resources.tally.status.runs` for a sibling that reports observed state, typed from the sibling's kind. A body name shadows a module resource of the same name, exactly as a body `!ref` resolves siblings first. A family is one name holding a map from element key to member reading — `string` keys for a map source, `int` keys for a list source, one map per loop of a nested family — so a repeat over the family's source reads `resources.crons[each.key].status.lastRun`, typed for string keys; an int-keyed family is left open by the analysis, like a list source's step results. A family's member identity (`crons['nightlyReport']`) is never a name in the record. Readings are fresh: a reading republished after a member runs is what the next read sees. The module rules apply unchanged: a body entry's startup (compile-eval) read of a sibling's observed state is `OBSERVED_STATE_IN_STARTUP_FIELD` unless the sibling is a `Telo.Provider` — the entry is then created after it, after every member of a family read through its index — and an entry of the body is invisible to the module's own resources (`CEL_UNKNOWN_FIELD`). Nothing starts a body's entries from the analysis's point of view, so `OBSERVED_STATE_NEVER_RUN` is not reported for a body sibling.

An expression reading nothing but `self` is resolved once, when the instance is created — unless it calls a function whose result differs per call (`uuidv4()`, `nowMillis()`), which is always evaluated where the nested kind evaluates the field.

The analyzer validates every expression against the scope in force at its position, so a typo like `self.tabel`, `inputs.fitlers` or `item.bodyy` is a `telo check` error rather than a runtime surprise. Where a scope is open — a name the declaring kind leaves untyped — a typo below it is not decidable and is not reported.

## `extends` and `Self`

`extends` declares the [`Telo.Abstract`](/reference/kernel/inheritance) this kind implements (e.g. `Auth.Credential` above). The prefix is an import alias, or **`Self`** — auto-registered to point at the declaring library's own module — when the abstract or composed kind lives in the same library. `Self.<Kind>` lets a template compose or implement a sibling kind without an import (a self-import would loop the loader), and resolves ungated, independent of `exports.kinds`. The CRUD example uses `Self.Reader` to compose its own internal handler kind.

## See also

- [Resource Definition](/reference/kernel/resource-definition) — every `Telo.Definition` field and `x-telo-*` annotation, including the no-controller execution rule.
- [Inheritance](/reference/kernel/inheritance) — `Telo.Abstract`, `extends`, and `Self`.
- [Authoring a Module](/extend/authoring-a-module) — the controller-backed path, for behaviour a template can't express.
- [Choosing by configuration](/learn/choosing-by-configuration) — `!if` / `!switch` outside a body, the dimensions a condition may read and how every combination is checked.
- [Sharing Across Libraries](/extend/library-resource-inputs) — `resources:` inputs and `lifecycle: shared`, for what a template's composition cannot reach.
- `modules/crud` and `modules/sql-repository` — real templated modules.
