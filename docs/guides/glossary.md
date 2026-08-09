# Glossary

Short definitions for the vocabulary the rest of the documentation assumes.

### Manifest

A YAML file of one or more `---`-separated documents. The first is a
`Telo.Application` or `Telo.Library`; each one after it declares a resource.

### Resource

One declared thing — a server, a handler, a connection. Written as a document
with a `kind:`, a `metadata.name`, and its configuration at the top level (there
is no `spec:` wrapper).

### Kind

The type of a resource, written `<Alias>.<Name>` — e.g. `Http.Server`. The
prefix is an **import alias you chose**, not a fixed namespace.

### `Telo.Definition`

The document that *declares* a kind: its JSON Schema, its capability, and the
controller that implements it. Kinds are declared in modules, never built into
the kernel.

### `Telo.Abstract`

A kind that cannot be instantiated — a contract with no default implementation
(`Sql.Connection`, `Codec.Encoder`). Something else `extends` it to provide one.

### Controller

The code implementing a kind's lifecycle. Ships inside its module's artifact and
is loaded at boot. Which one to load is named by a PURL on the definition.

### Capability

A kind's lifecycle role — `Telo.Service`, `Telo.Runnable`, `Telo.Invocable`,
`Telo.Provider`, `Telo.Mount`, `Telo.Sink`, `Telo.Type`. It determines which
reference slots will accept the kind.

### Module

An importable unit of kinds and resources: a `Telo.Library`, or the
`Telo.Application` at the root. Also the unit of publishing and versioning.

### `Telo.Application`

The runnable root of a manifest. The only place that reads host environment
variables, the only place with `ports:` and `targets:`, and never importable.

### `Telo.Library`

An importable unit. Has no `targets:`, cannot be run directly, and exposes only
what it lists under `exports:`.

### Import alias

The PascalCase name you bind a module to in `imports:`. It becomes the prefix for
that module's kinds (`Http.Server`) and for its exported instances
(`!ref Console.writeLine`).

### Target

An entry in an application's `targets:` list — what to start once everything has
initialized. Takes a `Telo.Runnable` or a `Telo.Service`.

### Hold

What a long-lived resource takes to keep the process alive. `Http.Server`
acquires one when it starts listening and releases it on teardown; the app exits
when the last hold is gone.

### `!ref`

The reference tag. `!ref Name` for a resource in this module, `!ref Alias.name`
for an instance an import exports. See [`!ref` and `!cel`](/learn/refs-and-cel).

### `!cel`

The expression tag. Wraps a [CEL](https://github.com/google/cel-spec) expression
evaluated against whatever is in scope at that point.

### Snapshot / published state

What a resource's author *configured*, read by the kernel after it initializes
and published at `resources.<name>.<field>` for other resources' CEL.

### Observed state

What a resource *learned* while running — reported by its controller and
published at `resources.<name>.status.<field>`. It exists only after the
resource has started, which is why reading it in a startup field is a static
error.

### Invocation contract

A kind's or instance's declared `inputType` / `outputType`. The kernel binds it
at construction, fills declared defaults, and validates every call — so a
contract violation is `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID`, not corrupt
data downstream.

### `inputs` / `outputs` vs `inputType` / `outputType`

`inputs` and `outputs` are always **values**; `inputType` and `outputType` are
always **schemas**. No exceptions anywhere in Telo.

### Scope

A region where resources exist only for the duration of a run — a
`Run.Sequence`'s `with:` block, for instance. Scoped resources are created on
entry, torn down on exit, and fresh per run.

### Init loop

The multi-pass pass over every resource: one whose dependency is not ready is
deferred and retried next pass. This is why you never declare an ordering — it
is derived from the references.

### Analyzer

The static checker behind `telo check`, the VS Code extension, and the load
phase of `telo run`. Resolves imports, validates against kind schemas, and
type-checks every CEL expression.

### Diagnostic

A static finding, with an `UPPER_SNAKE_CASE` code and a source location.
Runtime failures use `ERR_*` codes instead. Both are listed in the
[diagnostics reference](/reference/diagnostics).

### `x-telo-*` annotations

Extensions in a kind's JSON Schema that tell the tooling what a field *means* —
which kinds a reference slot accepts (`x-telo-ref`), whether a field is
evaluated (`x-telo-eval`), what CEL context is in scope (`x-telo-context`). This
is how the analyzer and the editor stay generic: they hardcode no kind.

Nearly all of them are metadata that changes no validation. `x-telo-binary` is
the exception: bytes have no JSON Schema type, so the annotation itself is what
checks the slot — and because bytes always arrive by reference, an inline literal
where one is expected is a static error. A union with a byte branch must use
`anyOf`, not `oneOf`: tooling that does not know the keyword reads that branch as
matching anything, which would make the union ambiguous.

### Module artifact

A published module: `telo.yaml` plus layers for controllers and assets, each
addressed by digest. Verified against the `#sha256-` pin on the import that
named it.

### Hub

[hub.telo.run](https://hub.telo.run) — the federated index of published modules
across registries, and the authoritative reference for any kind's schema. Also
serves the MCP endpoint coding agents use.
