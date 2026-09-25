---
sidebar_label: Diagnostics reference
slug: /reference/diagnostics
description: Every diagnostic code the Telo analyzer and runtime can emit, what triggers it, and how to fix it.
---

# Diagnostics reference

Every code Telo can emit, with what triggers it and what to do. Look a code up
here — the message text contains your resource names, but the code is stable.

Telo reports problems in two places:

- **Static diagnostics** come from the analyzer — `telo check`, the
  [VS Code extension](/build/vscode), and the load pass of `telo run`. They
  carry an `UPPER_SNAKE_CASE` code, a file, and a line. Nothing has run yet.
- **Runtime errors** come from the kernel while loading, initializing, or
  dispatching. They carry an `ERR_*` code.

`telo check` exits `1` if any **error** is present; warnings alone do not fail
it.

For the workflow around all this — what the analyzer checks, what it cannot,
how to read a failure, and the debugging flags — see
[Catching errors before they run](/learn/static-analysis).

## Static diagnostics

### Kinds and definitions

| Code | What it means and what to do |
| --- | --- |
| `UNDEFINED_KIND` | No `Telo.Definition` for this `kind:`. Check the alias prefix matches an `imports:` entry, and that the spelling matches the module's exported kind. |
| `KIND_NOT_EXPORTED` | The alias resolves, but the target library does not list that kind in `exports.kinds`. It is private to that module — you cannot construct it. |
| `ABSTRACT_KIND_INSTANTIATED` | The `kind:` names a `Telo.Abstract` — a contract for `x-telo-ref` slots, with no controller to construct. The kernel refuses it at `create()`. Write one of the implementations the message lists. Applies to an inline `{ kind, …config }` at a reference slot too. |
| `MISSING_KIND_OR_NAME` | Every resource doc needs `kind:` and `metadata.name`. |
| `DUPLICATE_RESOURCE_NAME` | Two declarations in one module scope share a name; the kernel would fail with `ERR_DUPLICATE_RESOURCE`. Rename one. The namespace covers everything a module declares, not just its resources: an **import alias**, a `Telo.Definition` / `Telo.Abstract` name, and the module's **own `metadata.name`** all live in it — so an application named after one of its own imports (`metadata.name: Scheduler` beside `Scheduler: oci://…/scheduler`) is a collision, and the two lines do not look like one name written twice. Two imports sharing an alias is reported as `DUPLICATE_IMPORT_ALIAS` instead. |
| `INVALID_NAME` | A name is not `^[A-Za-z_][A-Za-z0-9_]*$`, or is a CEL keyword — so it cannot be referenced. A `-` is read by CEL as subtraction (and where a bare name is in scope, silently evaluates instead of failing); a `.` is what `!ref` splits alias from name on. Applies to resources, kinds, modules, import aliases, step names and `variables:` / `secrets:` / `ports:` keys. |
| `INVALID_TYPE_NAME` | A type-level name (module, kind, import alias, or a `Telo.Type` resource) does not start with an uppercase letter. The alias-qualified `<Alias>.<Kind>` grammar accepts only PascalCase, so nothing could `extends:` it. |
| `NAME_CASE_CONVENTION` ⚠️ | A value-level name (resource instance, step, `variables:` / `secrets:` / `ports:` key, CEL binding) does not start with a lowercase letter. camelCase names a value, PascalCase names a type — see the [style guide](../guides/style-guide.md). |
| `EXTENDS_MALFORMED` | `extends:` must be the string form `<Alias>.<Kind>` (use `Self.<Kind>` for a kind in the same library). |
| `EXTENDS_UNKNOWN_TARGET` | The `extends:` target is not an exported kind of that alias. |
| `EXTENDS_CAPABILITY_MISMATCH` | A child declares a different `capability:` than its ancestor. Capability is inherited and immutable — omit it, or restate it identically. |
| `CAPABILITY_NOT_DECLARABLE` | `capability: Telo.Executable` — that name is an `x-telo-ref` slot constraint (the parent `Telo.Invocable` and `Telo.Runnable` extend), not a lifecycle role. Declare `Telo.Invocable` (invoke) or `Telo.Runnable` (run). |
| `CAPABILITY_SHADOWS_EXTENDS` ⚠️ | `capability:` names a user-declared abstract. Capability names a kernel lifecycle role; use `extends:` for a contract. |
| `PROVIDER_MISSING_IMPLEMENTATION` | A `Telo.Provider` definition needs either `controllers:` or a `provide:` body. |
| `SCOPE_ENTRY_NOT_INLINE` | Entries in an `x-telo-scope` block must be inline declarations (`kind:` + `metadata.name`), not references. |
| `SCOPED_NAME_OUT_OF_REACH` | An inline declaration written beside a `with:` block — a step's `invoke: { kind: … }` — names a resource that block declares, by `!ref` or as `resources.<name>` in CEL. The declaration is created where its sequence is, outside the scope, so the name does not reach it. Declare it under `with:` with a name of its own and invoke it with `!ref`. |
| `EXTENDS_CLOSED_PARENT_ADDS_FIELD` | A child without `base:` declares a field its parent does not have, but the parent closes its schema (`additionalProperties: false`). Without `base:` the child's whole config is forwarded as the parent's, so the field is rejected at creation. Add a `base:` mapping, or drop the field. |
| `TEMPLATE_DISPATCH_UNKNOWN` | A templated definition's `invoke:` / `run:` / `provide:` / `mount:` is a `!ref` naming no entry in its own `resources:`. The message lists the entries that exist. |
| `DEPRECATED_TEMPLATE_ENTRY_NAME` ⚠️ | A `resources:` entry is named by an expression. Every instance of a template owns its children, so a per-instance suffix is not needed — and a `!ref` is looked up verbatim, so nothing can name such an entry. Write a literal. Still runs: published artifacts carry this spelling, so the kernel reads it. While one is present the dispatch-target checks are switched off for that kind. |
| `DEPRECATED_TEMPLATE_DISPATCH_FORM` ⚠️ | A dispatch slot written as a bare string or `{ kind, name }` rather than `!ref <entry>`. Still runs, for the same reason. |
| `TEMPLATE_REF_UNKNOWN` | A `!ref` inside a template body's entry names neither a sibling entry nor a resource of the declaring module. |
| `TEMPLATE_REF_COMPUTED` | A `!cel` expression inside a template body's entry sits at, or above, a reference slot and is not a bare `self.<path>`. CEL values are data, so a reference cannot come out of one. Forward the whole value with `!cel "self.<path>"`, already shaped as the slot expects, or write the slot as `!ref`. |
| `TEMPLATE_FORWARD_INCOMPATIBLE` | A templated definition forwards `self.<path>` into an entry field, but the schema it declares for that path is not assignable to the entry kind's field: a type conflict, or a field the entry requires that the declaration does not have. A consumer's forwarded value is checked against the entry's field (its diagnostics land on the consumer's own line, under their usual codes), so a disagreeing declaration only describes values the entry refuses. Align the declaration with the entry's field. |
| `BASE_WITH_TEMPLATE_BODY` | A definition declares `base:` alongside `resources:` / `controllers:` / a dispatch slot. `base:` is read only on the inherited-controller path, which a body switches off — so it would never be evaluated. Drop one or the other. |
| `EXPORT_KIND_UNKNOWN` | A `Telo.Library`'s `exports.kinds` entry names no kind the library declares. A bare name that is an IMPORTED kind is called out separately: re-export it as `Alias.Kind`, or declare a local kind that extends it. |
| `EXPORT_RESOURCE_UNKNOWN` | A `Telo.Library`'s `exports.resources` entry names no resource the library declares, or an instance the aliased import does not export. |

### References

| Code | What it means and what to do |
| --- | --- |
| `UNRESOLVED_REFERENCE` | A `!ref` names a resource that does not exist in scope. Check spelling, and that a scoped name is used inside its scope. |
| `REFERENCE_KIND_MISMATCH` | The referenced resource's kind is not accepted by that slot. The slot's `x-telo-ref` constraint names what it takes; a child of that kind is also accepted. A slot constrained to a callable abstract also accepts a function whose signature stands in for it — results covariant, parameters contravariant by position and by name, and deterministic where the abstract requires it — so for a function the message names the parameter that differs, or the chain of calls to the non-deterministic leaf. |
| `INVALID_REFERENCE_FORM` | A reference was written as a bare string or `{ kind, name }`. Write `!ref Name` or `!ref Alias.Name`. |
| `INVALID_REFERENCE` | A reference object is missing string `kind` / `name` fields. |
| `DEPENDENCY_CYCLE` | Resources depend on each other in a loop, so no boot order can construct them. The message traces the loop; one diagnostic per loop, anchored on a resource in it. Remove one of the references in the loop. A module call is a dependency too, so a function whose body calls itself — directly or through another function — is a cycle: recursion is refused, not deferred. Fails at runtime as `ERR_CIRCULAR_DEPENDENCY`. |
| `X_TELO_REF_UNRESOLVED` | A kind's own `x-telo-ref` constraint names nothing resolvable — a module-authoring bug, in the module that declares the slot. |
| `X_TELO_REF_LEGACY_IDENTITY` ⚠️ | The module uses the deprecated `"<namespace>/<module>#<Kind>"` ref form. Still resolves; the module should migrate to the alias form. |
| `X_TELO_REF_INVALID_USE` | A structured `x-telo-ref` carries an unrecognized `use` token (a typo would otherwise silently degrade to the legacy no-use reading), or a `use` case map whose `by` is not a JSON Pointer. Valid uses: `schema`, `dependency`, `call`, `detached`, `trigger.inbound`, `trigger.consumer`. |
| `X_TELO_REF_MISSING_USE` | The structured `x-telo-ref` form declares no `use`. Say what the declaring resource does with the target; only the legacy bare-string spelling may omit it. |
| `X_TELO_REF_MISSING_KIND` | A structured `x-telo-ref` declares no `kind`, so the slot constrains nothing and the editor has nothing to pick against. |
| `X_TELO_REF_USE_CONFLICT` | `anyOf` branches of one slot declare disagreeing `use`s. `use` is a property of the slot — declare the acceptable kinds as one `kind:` list with one `use`. |
| `X_TELO_REF_DYNAMIC_SELECTOR` | A `use` case map's selector field is written in CEL, so which `use` holds cannot be resolved statically. Write the mode as a literal (or rely on the schema default), or split the wiring into one resource per mode. |
| `MOUNT_ON_NON_MOUNT` / `MOUNT_DISPATCHER_CONFLICT` | `mount:` used on a non-Mount definition, or alongside another dispatcher (`invoke:` / `provide:` / `run:`). |
| `PROVIDE_ON_NON_PROVIDER` / `PROVIDE_DISPATCHER_CONFLICT` | `provide:` on a definition that is not a `Telo.Provider`, or beside another dispatcher. |

### CEL

| Code | What it means and what to do |
| --- | --- |
| `CEL_SYNTAX_ERROR` | The expression does not parse. |
| `CEL_UNKNOWN_IDENTIFIER` | The expression's root name (`variabels`, `step`, `req`) is not in scope at this site. What is in scope depends on the field — see [`!ref` and `!cel`](/learn/refs-and-cel). |
| `CEL_UNKNOWN_FIELD` | A property does not exist on the value's schema at that path. |
| `CEL_TYPE_ERROR` | The expression's result type does not match what the field declares (`returns 'string' but the field expects 'int'`), or the type-checker rejected the expression outright. Cast (`int(...)`, `string(...)`) or fix the field. |
| `CEL_UNKNOWN_FUNCTION` | The expression calls a function that does not exist. The message suggests the nearest name; `telo cel functions` lists them all. |
| `CEL_WRONG_CALL_FORM` | The function exists but is called the wrong way round — a method written as a global (`size(x)` vs `x.size()`), or vice versa. The message shows the correct spelling. |
| `CEL_TYPE_ARGUMENT_MISMATCH` | The expression yields a parameterised value type (`Telo.Stream` of `Telo.Bytes`) whose arguments disagree with the field's declared ones. |
| `CEL_NULLABLE_ACCESS` | Dereferencing a value whose schema admits `null` without a guard — or an `!interpolate` hole that is such a value, since a null has no text. |
| `INTERPOLATION_HOLE_NOT_CONVERTIBLE` | An `!interpolate` hole's type has no `string()` conversion (a list, a map). Convert it inside the hole, or write the whole value as `!cel`. |
| `UNTAGGED_INTERPOLATION` | A plain string holds `${{`, which is never evaluated. Loading normally migrates it, so this means it was read without migrations or no hole can be read out of it (`"${{ foo"`). Run `telo migrate`, or tag the text `!literal` if it is literal. In an imported library it is reported at your import of it, since the library then fails to load; import a version that fixes it. |
| `DEPRECATED_UNTAGGED_INTERPOLATION` ⚠️ | A plain string holding `${{ }}` — the legacy spelling. It still runs, rewritten at load: a lone hole to `!cel`, text with holes to `!interpolate`. `telo migrate` writes the same rewrite to the file. |
| `CEL_IN_NON_EVAL_FIELD` | The field is never evaluated, so the expression would be read as a literal. |
| `CEL_NONDETERMINISTIC_IN_COMPILE_FIELD` ⚠️ | `now()`, `uuidv4()` or another volatile call — or a module function that reaches one, named by its chain (`Billing.isStale → now()`) — sits in a field evaluated once at startup, so the value is baked in at load and never changes. Move it to a per-call field if it should vary. |
| `ENGINE_DIAGNOSTIC` | A templating tag other than `!cel` (for example `!sql`) reported a problem with its body. The message carries the engine's own text. |
| `UNKNOWN_ENGINE` | A `!<tag>` names a templating engine that is not registered. |
| `UNUSED_DECLARATION` ⚠️ | A declared `variables.*` / `secrets.*` entry is referenced by no CEL expression. Usually a typo at the use site. |
| `BINDING_CYCLE` | A named binding (`bindings:` on `Run.Value` / `Run.Choice`) references itself, directly or through other bindings. |
| `BINDING_NAME_RESERVED` | A name that could never be read where it is written: a CEL keyword; a name already in scope at that site (`inputs`, `steps`, …), which always wins; or one of the module's own names — an `imports:` alias, `Self`, or its `metadata.name` — through which a call `<name>.f(…)` reaches that module's function instead. Covers a `bindings:` key, a comprehension variable and a `cel.bind` name. |
| `IMPORT_ALIAS_SHADOWS_CONTEXT` | An `imports:` alias is also the name of a CEL variable a kind this module uses puts in scope (`x-telo-context`), so a call `<alias>.f(…)` reaches the imported module and the variable cannot be reached through one. Reported at the `imports:` key; rename the alias. |
| `BINDING_FIELD_AMBIGUOUS` | A kind's schema points `x-telo-bindings-from` at more than one field — a module-authoring bug. |

### Functions

A function is a resource whose capability resolves to `Telo.Callable` — a `Telo.Function` with a CEL `body`, or an instance of a callable kind with a controller — called from CEL through a module name: `Self.fn(x)` or `<ModuleName>.fn(x)` for one the module declares, `<Alias>.fn(x)` for one an import lists in `exports.resources`. Every code here is reported for the entry's own modules; a dependency's is refused by the kernel when its caller is created. See [CEL functions](/extend/cel-functions).

| Code | What it means and what to do |
| --- | --- |
| `FUNCTION_UNRESOLVED` | A call through a module name reaches no resource: the module declares no resource of that name, or the receiver is not one of its imports. The message ends with the reason. Fails at runtime as `ERR_FUNCTION_UNRESOLVED`. |
| `FUNCTION_NOT_EXPORTED` | The imported library declares the resource but does not list it in `exports.resources`. Export it, or call something it does export. Fails at runtime as `ERR_FUNCTION_NOT_EXPORTED`. |
| `FUNCTION_NOT_CALLABLE` | The name reaches a resource whose capability does not resolve to `Telo.Callable`; the message names its kind. Only a function can be called. Fails at runtime as `ERR_FUNCTION_NOT_CALLABLE`. |
| `FUNCTION_ARITY_MISMATCH` | The call passes a number of arguments no parameter list of the function accepts — more than it declares, or fewer than its required parameters. Fails at runtime as `ERR_FUNCTION_ARITY_MISMATCH`. |
| `FUNCTION_ARGUMENT_MISMATCH` | An argument's CEL type — or, for an argument written as a plain chain, its declared shape — does not satisfy the parameter's schema. |
| `FUNCTION_RETURN_MISMATCH` | A `Telo.Function`'s `body` yields a type its `returns:` does not admit. |
| `FUNCTION_CALL_UNBOUND` | A module call sits where the runtime binds no function: an Application's `logging:` block, resolved while the application loads, or a `Telo.JsonSchema` rule `condition`, evaluated against the value alone. Compute the value elsewhere. |
| `CALLABLE_DEFINITION_INVALID` | A callable kind or function breaks a rule of what a function is: a signature or `deterministic:` on a kind whose capability is not `Telo.Callable`; `deterministic:` on an instance (the claim belongs to the kind supplying the code — and a `Telo.Function`'s determinism is derived, never declared); a kind extending `Telo.Function`; a `status:` block or a template body on a callable; a replaced signature on a kind that inherits its controller, which has no bridge to make it true. The message says which and what to do. Fails at registration as `ERR_CALLABLE_DEFINITION_INVALID`. |
| `FUNCTION_OPTIONAL_NOT_TRAILING` | A required parameter follows an optional one. A call is positional, so an optional parameter can only be omitted from the end — move it last. |
| `FUNCTION_TYPE_NAME_FORM` | A signature `schema:` names a shape as a bare string (`schema: Money`). Reference it: `schema: !ref Money` — the diagnostic carries that repair. |
| `FUNCTION_NAME_RESERVED` | A function is named after a CEL macro — `all`, `exists`, `exists_one`, `map`, `filter` or `bind`. CEL expands `<Module>.map(…)` as its own macro before a module call resolves, so most calls to it do not parse. Rename the function. |
| `X_TELO_REF_CALLABLE_UNTYPED` | A kind's slot holds a function through a bare `Telo.Callable` constraint, which says nothing about the signature — a wrongly typed function would pass `telo check` and fail with `ERR_INPUT_INVALID` when called. Constrain the slot to a callable abstract that declares `params` / `returns`. |

### Embedded files

| Code | What it means and what to do |
| --- | --- |
| `INCLUDE_PATH_INVALID` | An `!include-text` / `!include-bytes` path is empty, a URL, or a glob. An embed names exactly one file that ships inside the module; to read a file at runtime from elsewhere, use `Fs.File`. |
| `INCLUDE_PATH_ESCAPES_MODULE` | The path is absolute, or climbs above the module root. Paths are relative to the directory holding `telo.yaml`, and only a file inside the module can be carried by its artifact. |
| `INCLUDE_OUTSIDE_RESOURCE` | An embed is written on a doc that is never instantiated (`Telo.Application`, `Telo.Library`, `Telo.Import`), so nothing would ever read it. Move it onto the resource that needs the file. |

### Invocation contracts

| Code | What it means and what to do |
| --- | --- |
| `CONTRACT_INPUTS_MISMATCH` | The `inputs:` at a call site do not satisfy the target's declared `inputType`. |
| `CONTRACT_MISSING_MAPPING` | A child that inherits a controller declared its own `inputType`/`outputType` but no `inputs:`/`result:` bridge, so the inherited controller would never see the mapped shape. |
| `CONTRACT_INPUTS_SCHEMA_FORM` | `inputs:` was written as a JSON-Schema property map. `inputs`/`outputs` are always **values**; `inputType`/`outputType` are always **schemas**. |
| `CONTRACT_TYPE_NOT_FOUND` | A `!ref` names a type that does not resolve — in a kind's or resource's `inputType` / `outputType`, or in a signature's `params[].schema` / `returns.schema`, at the root or nested. |
| `CONTRACT_NOT_SUBSTITUTABLE` | A contract or signature that replaces an abstract ancestor's cannot stand in for it: an `outputType` or `returns` the ancestor's readers cannot read (covariant), an `inputType` or parameter its callers cannot send (contravariant), a parameter renamed (a holder calls with the ancestor's names), a different number of parameters, or a non-deterministic implementation of an abstract that requires determinism. |
| `TEMPLATE_TARGET_MISMATCH` | A templated definition's body does not satisfy the target kind's contract. |
| `UNCOVERED_THROW_CODE` | The handler declares an error code that no `catches:` entry covers. |
| `UNDECLARED_THROW_CODE` | A `catches:` entry names a code the handler never throws — usually a typo. |
| `THROWS_ON_NON_DISPATCH_CAPABILITY` | A `Telo.Definition` declares `throws:` with a capability other than `Telo.Invocable` or `Telo.Runnable`. A throw union describes what a caller can catch, and no caller awaits any other capability's entry point, so a thrown error there is a boot failure with nothing to render it. The kernel refuses the definition, so it is reported for a dependency's definition too. Drop `throws:`, or declare it on the kind that is dispatched. |
| `UNBOUNDED_UNION_NEEDS_CATCHALL` / `CATCHALL_NOT_LAST` | The throw union could not be enumerated, so `catches:` needs a catch-all; and a catch-all must come last. |
| `INHERIT_WITHOUT_STEP_CONTEXT` | A definition declares `throws: { inherit: true }` but dispatches nothing a failure can come back through: its schema has no step body and no reference slot whose `use` includes `call` or `trigger.consumer` (for a use case map, in any case; a slot declaring no use counts as `call`). `detached` and `trigger.inbound` targets run where no caller awaits them, and `dependency` / `schema` slots dispatch nothing. Add such a slot, or drop `inherit` and declare `throws.codes`. |
| `LIVE_VALUE_RETRIED` | A step passes a live value (a `Telo.Stream`) into a target, and either the step or the target declares a retry. A stream is consumed once; a re-attempt would pass an exhausted one. Drop the retry, or collect the stream into a plain value first. |

### Execution zones and durable regions

| Code | What it means and what to do |
| --- | --- |
| `ZONE_REQUIREMENT_UNSATISFIED` | A resource requires being reached through another's body (a `Sql.Command` through a `Sql.Transaction` on the same connection) and no path in the call graph provides it. Wrap the call, or drop the requirement. |
| `ZONE_REQUIREMENT_DEFERRED` ⚠️ | The requirement might be met at runtime but the analyzer cannot prove it — the edge is `trigger.consumer`, or its `use` selector is not statically resolvable. |
| `ZONE_EXPORT_UNSATISFIABLE` | A library exports a resource that carries an open zone requirement on something the library does not export, so no importer can ever satisfy it. Export the correlated resource too, or export something that goes through the provider. |
| `ZONE_PROVIDER_UNRESOLVED` | An `x-telo-requires-zone` names a kind that does not resolve in the declaring module — a module-authoring bug. |
| `ZONE_ANNOTATION_INVALID` | An `x-telo-provides-zone` / `x-telo-requires-zone` annotation is malformed — a correlation key that is not a JSON Pointer, an object missing `zone`, and so on. |
| `ZONE_ATTRIBUTE_UNKNOWN` | A providing slot declares an attribute outside the closed vocabulary (`atomic`, `idempotent`, `noSuspend`, `replayed`). The message suggests the nearest name. |
| `ZONE_ATTRIBUTE_INCOMPLETE` | A zone attribute is declared without its dependency (`atomic` requires `noSuspend`), or without the prose reason that is its value. |
| `ZONE_ATTRIBUTE_VIOLATED` | Something inside a region cannot honour what the region promises — a `Durable.Sleep` inside a `noSuspend` transaction, a retry whose backoff is long enough to park. The message prints both the region's reason and the rebuttal. Move it outside the region, or use a region that does not make that promise. |
| `DURABLE_NONDETERMINISM` | A volatile call (`uuidv4()`, `now()`) — or a module function reaching one, named by its chain, or a native function whose kind does not declare `deterministic: true` — sits inside a region declared idempotent. That region re-runs on a resume with its earlier effects intact, so a value that differs per pass makes the re-run something other than a no-op. Pin it once with `Durable.Value`. |
| `DURABLE_DETACH_FORBIDDEN` | A detached dispatch inside a durable region. Progress is recorded when a step completes, so detached work would be recorded as done while still running. Start a nested durable run instead. |
| `DURABLE_UNJOURNALABLE_RESULT` | A step inside a durable region invokes a target whose declared output is a live value. A stream cannot be recorded and replayed; collect what you need into a plain value inside the step. Fails at runtime as `ERR_DURABLE_UNJOURNALABLE_VALUE`. |

### Resource rules and referrer rules

| Code | What it means and what to do |
| --- | --- |
| `RESOURCE_RULE_VIOLATED` | A rule the kind declares (`x-telo-resource-rules`) does not hold for this resource — an index naming a column its table does not declare, for instance. The author's own `code` is in `data.rule`; the message is theirs. |
| `RESOURCE_RULE_SKIPPED` ℹ️ | A rule could not be evaluated because a value it reads is a `!cel` expression only known at runtime. Reported, never silently dropped. |
| `RESOURCE_RULE_UNEXERCISED` ℹ️ | A rule's `in:` collection was empty on every resource of the kind, so the rule never ran. Usually fine; worth a look if you expected it to fire. |
| `RESOURCE_RULE_INVALID` | The rule itself is defective — it calls a host-backed or non-deterministic function, names a collection the kind does not declare, does not parse, or threw while evaluating. A module function is judged by what it reaches: a `Telo.Function` whose body calls only deterministic, host-free functions is admitted and evaluated, one reaching `now()` is refused naming the chain, and a native function is always host-backed. Anchored on the declaring definition; a warning when that definition belongs to a dependency. |
| `REFERRER_RULE_VIOLATED` | A kind's requirement on *whoever references it* (`x-telo-referrer-rules`) does not hold — a server mounting `Http.Reference` with no `openapi:` block. Reported on the referrer, at the slot, naming the kind that declared the rule. |
| `REFERRER_RULE_SKIPPED` ℹ️ / `REFERRER_RULE_UNEXERCISED` ℹ️ / `REFERRER_RULE_INVALID` | As for resource rules. `UNEXERCISED` matters more here: nothing matching the `referrer:` filter ever referencing the kind is what a typo in the filter looks like from outside. |

### Modules, imports, and exports

| Code | What it means and what to do |
| --- | --- |
| `DUPLICATE_IMPORT_ALIAS` | An alias is declared twice in one module scope. Aliases never shadow — rename one. |
| `MODULE_VERSION_CONFLICT` | One module is imported at incompatible major versions. Align the pins. |
| `MODULE_VERSION_HOISTED` ⚠️ | One identity imported from two sources whose contents differ; one won. Align them to be sure which. |
| `INVALID_EXPORT` | `exports.resources` entries are plain name strings (`Name` or `Alias.Name`) — not `!ref`. |
| `LIBRARY_ENV_KEY_REJECTED` | `env:` is only valid on a `Telo.Application`. A library receives values from its importer. |
| `LIBRARY_ARG_KEY_REJECTED` | `arg:` is only valid on a `Telo.Application`: only the application being run reads the command line. A library receives values from its importer. |
| `ARG_BINDING_INVALID` | An Application entry's `arg:` cannot be parsed against: a variable bound by `arg:` alone with no `default:` (a runner session could not supply it), a flag spelled `no-…` or `help`, a type the command line cannot carry (only scalars and arrays of scalars), two entries sharing a flag, short or position, a gap between positions, or an array before the last position. See [Application arguments](/reference/kernel/specs/application-arguments). |
| `ARG_BINDING_ON_SECRET` | A `secrets:` entry carries `arg:`. A command line is readable in the process table and in shell history — bind the secret with `env:`. |
| `MANIFEST_PARSE_FAILED` | The YAML itself did not parse. |
| `MODULE_REQUIRES_NEWER_RUNTIME` | The module declares `requires: telo: ">=X"` (or a `host:` axis) and this runtime is older. **The module is fine; the runtime is too old.** Every other diagnostic from that module is suppressed, since they are consequences of the same skew. Upgrade telo, or pin the module to a version whose range accepts yours. See [Upgrades & version skew](/deploy/upgrades). |
| `REQUIRES_INVALID` | A `requires:` block is malformed: `^` / `~` / a bare version / `\|\|` / a wildcard, or an unknown axis. Each bound must be testable — write `>=0.80.0`. Reported only for the entry's own modules. |
| `METADATA_UNKNOWN_FIELD` ⚠️ | A `metadata:` key is a near-miss of a known one (`licence` → `license`). Nothing reads an unrecognised key, so it declares nothing. |
| `METADATA_INVALID_TYPE` ⚠️ | A known `metadata:` field has the wrong type (`categories` must be a list of strings, `deprecated` an object). |
| `LIBRARY_CANDIDATE_INVALID` / `LIBRARY_CANDIDATE_DUPLICATE` | An `exports.code:` entry is malformed, or two entries declare the same format/platform selector. A module has one entry point per selector. |

### Sharing across libraries

| Code | What it means and what to do |
| --- | --- |
| `RESOURCE_INPUT_MISSING` | The imported library declares a `resources:` input the import does not supply. Add `resources: { <name>: !ref <instance> }` to the import's object form. |
| `RESOURCE_INPUT_UNKNOWN` | The import supplies a resource input the library does not declare. The message lists the declared ones. |
| `RESOURCE_INPUT_UNRESOLVED` | The supplied value is not a `!ref`, or names a resource this module does not declare. |
| `RESOURCE_INPUT_KIND_MISMATCH` | The supplied instance's kind does not satisfy the input's declared constraint (a child of the constrained kind is accepted). |
| `RESOURCE_INPUT_KIND_UNRESOLVED` | In the declaring library, an input's `kind:` does not resolve — write it alias-qualified (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`). |
| `RESOURCE_INPUT_EXPORTED` | A library lists one of its own inputs in `exports.resources`. An input is something the importer supplies, so there is nothing to export. |
| `SHARED_LIBRARY_CONFLICT` | Two imports reach one `lifecycle: shared` library with different `variables` / `secrets` / `resources` values. A shared library is one instantiation for the whole application, so every import must agree. Reported at both imports, naming the key — never a secret's value. |
| `SHARED_LIBRARY_OVERRIDE` | An import of a `lifecycle: shared` library declares a per-import `logging:` or `runtime:` override, which cannot apply to an instantiation it does not own. |

### Schemas and types

| Code | What it means and what to do |
| --- | --- |
| `SCHEMA_VIOLATION` | The resource does not match its kind's schema — usually an unknown or misspelled field, since kind schemas are closed. A **required field the kind's parent declares** names that parent and points at `base:`: a child that `extends` without a `base:` mapping is authored against `merge(parent, own)`, so the parent's required fields stay on the child's surface and a kind written to supply one still demands it from the consumer. Adding `base:` sets them internally and narrows the surface to the child's own schema. A value outside a [Telo format](/extend/telo-formats)'s grammar (`format: css-selector`) names where the checker stopped and what it expected. |
| `SCHEMA_COMPILE_ERROR` | A definition's `schema:` is not valid JSON Schema. |
| `DUPLICATE_SCHEMA_ID` | A type name collides with a kind name in the same module. |
| `SCHEMA_TYPE_REF_UNKNOWN_ALIAS` / `SCHEMA_TYPE_REF_UNRESOLVED` | A schema `$ref` names an unknown alias, or a module that does not declare that type. |
| `INVALID_SCHEMA_FROM` / `SCHEMA_FROM_MISSING_PATH` | An `x-telo-schema-from` annotation is malformed or points at an unresolvable anchor. |
| `DEPENDENT_SCHEMA_MISMATCH` | A value does not match the schema derived from a sibling reference. |
| `BASE_UNKNOWN_FIELD` / `BASE_MISSING_REQUIRED` / `BASE_SCHEMA_MISMATCH` | A `base:` construction mapping sets a field the parent kind does not have, omits one it requires, or supplies the wrong shape. |
| `X_TELO_TYPE_UNKNOWN` | `x-telo-type` names something that is not a built-in value type (`Telo.Bytes`, `Telo.Duration`, `Telo.Stream`, `Telo.TcpPort`, `Telo.Timestamp`, `Telo.UdpPort`, `Telo.Uint64`). A named *shape* is written as `!ref` to a `Telo.JsonSchema`, not here. Suggests the nearest name. |
| `X_TELO_TYPE_ARGUMENT_UNKNOWN` | The object form supplies a type argument the value type does not declare (`Telo.Stream` takes only `of`). |
| `SCHEMA_PROJECTION_INVALID` | A kind's `x-telo-schema-projection` / `x-telo-schema-map` is malformed, carries a key the annotation does not declare, names a `nested` field that is not a collection of the same entries, or is written under `schema:` instead of beside it — a module-authoring bug. See [Schema projections](/extend/schema-projections). |
| `SCHEMA_PROJECTION_FROM_UNRESOLVED` | A slot declares `x-telo-schema-projection-from`, but the referenced declaration cannot be projected — the reference does not resolve, matches several resources, its target declares no projection, or an entry contains itself through `nested`. Fails at runtime as `ERR_SCHEMA_PROJECTION_UNRESOLVED`. |
| `SENSITIVE_ANNOTATION_MISPLACED` | `x-telo-sensitive` was written somewhere other than a declared contract (`inputType` / `outputType`) — a function's signature included, whose arguments ride no trace payload — where nothing reads it — so the value would ride the debug wire in clear. See [Marking a contract field sensitive](/extend/sensitive-contract-fields). |
| `SENSITIVE_ANNOTATION_INVALID` | `x-telo-sensitive` must be exactly `true`. It is a marker, not a level. |

### Observed state

| Code | What it means and what to do |
| --- | --- |
| `OBSERVED_STATE_IN_STARTUP_FIELD` | `resources.<n>.status.*` was read in a field that resolves before anything runs. Observed state exists only once the resource has started. |
| `OBSERVED_STATE_NEVER_RUN` | The producer of that status can never start — it is in no `targets:` and named by no step's `invoke:`. |
| `OBSERVED_STATE_REQUIRED_FORBIDDEN` | `required:` is not allowed inside `status:` — every declared field is mandatory once running; a sometimes-absent one is declared nullable. |

### Controllers, logging, artifacts

| Code | What it means and what to do |
| --- | --- |
| `CONTROLLER_INVALID_SELECTOR` / `CONTROLLER_UNKNOWN_QUALIFIER` | A controller PURL's platform selector or qualifier is malformed. |
| `CONTROLLER_DYLIB_ABI_MISSING` | A `pkg:telo/local/dylib` candidate states no `abi`, or one outside the `telo` family. A dylib is built against one version of the Rust controller ABI; add `abi=telo-<version>` (e.g. `abi=telo-3`), or the Rust kernel downloads it on every host and refuses it only when opening it. |
| `CONTROLLER_NAPI_ABI_FORBIDDEN` / `LIBRARY_NAPI_ABI_FORBIDDEN` | A `napi` controller candidate or `exports.code:` entry states an `abi`. An N-API addon is ABI-stable across runtime releases; remove `abi`, which would keep it from loading anywhere else. |
| `CONTROLLER_LIBC_OFF_LINUX` / `LIBRARY_LIBC_OFF_LINUX` | A controller candidate or `exports.code:` entry states `libc` for an `os` other than `linux`, where libc is never determined, so it could never match a host. Remove `libc`. |
| `NATIVE_*` | A module doc's `native:` block: `NATIVE_NODE_ABI_MISSING`, `NATIVE_NAPI_ABI_FORBIDDEN`, `NATIVE_LIBC_OFF_LINUX`, `NATIVE_ENTRY_DUPLICATE`, `NATIVE_PATH_SHARED`, `NATIVE_PATH_NESTED`, `NATIVE_PATH_CLAIMED`, `NATIVE_PATH_ESCAPES_MODULE`, `NATIVE_ENTRY_INVALID`. Each is described in [Native files](/extend/native-files#what-telo-check-reports). |
| `SOURCE_*` | A module doc's `sources:` block: `SOURCE_INVALID`, `SOURCE_URL_PLACEHOLDER_UNKNOWN`, `SOURCE_URL_INSECURE`, `SOURCE_ENTRY_INVALID`, `SOURCE_ENTRY_DUPLICATE`, `SOURCE_ENTRY_NESTED`, `SOURCE_ENTRY_UNCLAIMED`, `SOURCE_ENTRY_UNPINNED`, `SOURCE_BUILD_UNPINNED`, `SOURCE_LINK_TARGET_UNRESOLVED`, `SOURCE_LINK_CYCLE`. Each is described in [Native files](/extend/native-files#what-telo-check-reports-1). |
| `CONTROLLER_TOOL_MISSING` | Every `controllers:` candidate of some kind you import needs a program this machine does not have — `npm` (or whatever `TELO_PKG_MANAGER` names) for an npm-delivered controller, `cargo` for a Rust one. A **warning**, not an error, and reported against the `imports:` entry that pulled the module in: the machine running `telo check` is often not the machine that will run the app, so this says nothing about whether the manifest is right. At run time the same absence is reported by the loader, from the spawn's own failure. A kind that also offers a bundled controller is never reported — the kernel takes that candidate and needs nothing. |
| `INVALID_LAYER_INDEX` | The published `layers:` index is malformed. |
| `INVALID_REDACTION_PATH` | A `logging.redact.paths` entry does not parse. Bad paths are caught here rather than silently failing to redact at runtime. |
| `LOG_SINK_ON_FULL_UNSUPPORTED` | The sink does not support the requested `on_full:` policy. |

### Releasing modules (`telo release`)

These come from the release planner rather than from `telo check`. See
[Releasing modules](/extend/releasing-modules).

| Code | What it means and what to do |
| --- | --- |
| `CHANGELOG_ENTRY_REQUESTED` ⚠️ | A module's own files changed but no fragment under `.changes/pending/` names it, so its changelog will not mention this release. `telo release add --module <path> --kind <Kind> --body "…"`. |
| `FRAGMENT_UNKNOWN_MODULE` | A fragment names a module key that is not in the workspace (`release.modules` in `telo-workspace.yaml`). |
| `MAJOR_BUMP_REJECTED` | A fragment declares a `Changed` / `Removed` kind, which induces a major bump. The repo is deliberately pre-1.0 and ships breaking changes as minors — use `Added` or `Fixed`. |
| `LEDGER_VERSION_MISMATCH` | A module's `metadata.version` disagrees with what `.changes/ledger.yaml` records as published. Reconcile with `telo release verify`. |
| `LEDGER_REGISTRY_MISMATCH` | A module's ledger digests were taken against a different registry base than this run built against, so nothing can be compared. Per module, because a workspace may publish its subtrees to different bases. |
| `NO_DESTINATION_KNOWN` | A module has never published, its `release.modules` entry declares no `registry:` and neither does the block. Declare one, pass `--registry`, or set `TELO_OCI_REGISTRY`. |
| `DESTINATION_COLLISION` | Two modules resolve to one ref, because a ref is the registry base plus the module's own directory name. Rename a directory, or give one subtree its own `registry:`. |
| `IMPORT_DESTINATION_CONFLICT` | A relative import between two workspace modules does not agree about where the target publishes. Publishing rewrites the import to the ref the importer's own path yields, so the artifact would name a module nobody pushes. Use a pinned remote import across a publish boundary. |

### The workspace marker (`telo-workspace.yaml`)

Reported by `telo release`, and by the editor as you type. See
[Workspaces](/guides/workspaces).

| Code | What it means and what to do |
| --- | --- |
| `WORKSPACE_MODULES_MOVED` | `modules:` is at the top level. It is release scope — indent it under `release:`. |
| `WORKSPACE_UNKNOWN_KEY` | A key nothing reads. A near-miss of a known one is an error, since its settings would go silently unapplied; an unrecognized top-level block is a warning, so a marker written for a newer telo still runs. |
| `WORKSPACE_INVALID_VALUE` | A wrong type, an entry that is neither a pattern string nor a mapping carrying `path:`, an `env.files` entry that is a path or a glob, or an empty `release.modules`. |
| `WORKSPACE_ENTRY_MATCHES_NOTHING` ⚠️ | A `release.modules` pattern under which no directory holds a `telo.yaml`, or an `env.roots` pattern matching no directory — usually a typo in a subtree name. |
| `WORKSPACE_ENTRY_SHADOWED` ⚠️ | Every module an entry matches is also matched by a later one, so last-match-wins leaves this entry's settings applying to nothing. |
| `WORKSPACE_MARKER_SHADOWED` ⚠️ | Another marker sits above this one, so everything beneath it takes a different cache root, different module keys and a different release scope. |

⚠️ = warning, ℹ️ = information; everything else is an error.

## Runtime errors

### Load and validation

| Code | What it means and what to do |
| --- | --- |
| `ERR_MANIFEST_VALIDATION_FAILED` | A declared `variables:` / `secrets:` / `ports:` entry was given by neither the command line nor the environment and has no default, or its value failed coercion — or the command line holds an argument the application does not declare. All failures are aggregated before any controller initializes. |
| `ERR_RUNTIME_INVALID` | An import's `runtime:` is neither a string nor an array of strings. |
| `ERR_CIRCULAR_DEPENDENCY` | A resource graph — the application's, or an imported library's — contains a cycle, a function calling itself included. The static form is `DEPENDENCY_CYCLE`. |
| `ERR_CALLABLE_DEFINITION_INVALID` | A callable kind, a function resource, or a kind holding a function through an untyped slot is refused at registration. The message lists each clause as `<CODE> at <path>: <message>`; the static forms are `CALLABLE_DEFINITION_INVALID`, `X_TELO_REF_CALLABLE_UNTYPED`, `FUNCTION_OPTIONAL_NOT_TRAILING`, `FUNCTION_TYPE_NAME_FORM`, `FUNCTION_NAME_RESERVED` and `CONTRACT_TYPE_NOT_FOUND`. |
| `ERR_INVALID_EXPORT` / `ERR_INVALID_REEXPORT` | A library's `exports.resources` entry is malformed, or re-exports through an alias it never imported. |
| `ERR_RUNTIME_EVAL_WITHOUT_INVOKE` | A kind declares `x-telo-eval: runtime` but its resources have no `invoke()`. Runtime evaluation expands a call's inputs, and `run()` / `provide()` take none, so nothing would ever expand the field. Use `x-telo-eval: compile` for a value resolved once at creation, or give the kind an invocable controller. |
| `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` | A resource's config does not match its kind's schema at creation. Normally caught earlier by `telo check` as `SCHEMA_VIOLATION`; at runtime it means the kernel was run without a check, or a value only known at creation (an embedded file, a CEL result) is the wrong shape. |
| `ERR_SHARED_LIBRARY_CONFLICT` / `ERR_SHARED_LIBRARY_OVERRIDE` | The runtime half of `SHARED_LIBRARY_CONFLICT` / `SHARED_LIBRARY_OVERRIDE`, authoritative because it holds resolved values: two imports of a `lifecycle: shared` library disagree, or one carries a per-import override. |
| `ERR_UNTAGGED_INTERPOLATION` | A plain string holding `${{` reached the compiler — read without migrations, or no hole can be read out of it. The static form is `UNTAGGED_INTERPOLATION`. |
| `ERR_SCHEMA_PROJECTION_UNRESOLVED` | A slot that opted into a declaration-derived shape (`x-telo-schema-projection-from`) got none at dispatch. Refused rather than degraded, since a repository kind would otherwise accept arbitrary keys in a SQL identifier position. |

### Initialization

| Code | What it means and what to do |
| --- | --- |
| `ERR_RESOURCE_INITIALIZATION_FAILED` | The multi-pass init loop gave up. It reports by **root cause**, not by count: resources that never ran because a dependency failed are classified as *derived* and attributed to the entry that actually broke, so the resource in the headline is the one to fix. Failures inside an imported library nest under that import. See [Resource lifecycle](/reference/kernel/resource-lifecycle). |
| `ERR_LOCAL_REF_PENDING` / `ERR_CROSS_MODULE_REF_PENDING` | A deferral, not a failure: this resource never ran because a dependency (local, or in an import) was not ready. It is always attributed to a real root cause. |
| `ERR_DUPLICATE_RESOURCE` | Two resources registered under one name. |
| `ERR_INCLUDE_FILE_NOT_FOUND` / `ERR_INCLUDE_UNREADABLE` | An `!include-*` path is confined and well-formed but names nothing, or names something that is not a readable file. The path is relative to the module root, not to the file the tag was written in. |
| `ERR_INCLUDE_FILE_TOO_LARGE` | The embedded file is over 32 MB. An embed is retained for the life of the resource; read a large payload at runtime with `Fs.File` instead. |
| `ERR_INCLUDE_PATH_INVALID` | Confinement re-checked at runtime, because the kernel does not require that `telo check` ran. |
| `ERR_REF_REQUIRED` / `ERR_REF_UNRESOLVED` | A required reference slot is empty, or its `!ref` did not resolve to a live instance. |
| `ERR_SCOPE_RESOURCE_NOT_FOUND` | A cross-module `!ref Alias.name` did not resolve to an instance the library exports. Check `exports.resources`. |
| `ERR_SCOPE_ENTRY_NOT_INLINE` | A scope block entry is a reference rather than an inline declaration. |
| `ERR_VISIBILITY_DENIED` | A resource referenced boot context it was not granted. |
| `ERR_KERNEL_STATE_INVALID` | A kernel operation was called out of order (embedding the kernel directly). |
| `ERR_RESOURCE_IDENTITY_UNBOUND` | A controller reached `ctx.self` or the zone surface before `create()` returned. Identity is minted at creation; move the access to `init()` or later. |
| `ERR_BINDING_CYCLE` | The runtime half of `BINDING_CYCLE`: named bindings resolved to a cycle while being evaluated. |
| `ERR_EFFECT_RECOVERY_FAILED` | An inverse (what `init()` / `run()` returned to undo themselves) refused during teardown. The cascade continued; the failures are aggregated here. |
| `ERR_EFFECT_NO_FRAME` / `ERR_EFFECT_NO_SCOPE` / `ERR_EFFECT_SCOPE_CLOSED` / `ERR_EFFECT_SCOPE_CLOSING` | A controller called `ctx.effect(...).perform()` outside any lifecycle frame, or on a resource already torn down. An effect must be registered while the frame that owns it is open — see [Authoring a module](/extend/authoring-a-module). |

### Dispatch

| Code | What it means and what to do |
| --- | --- |
| `ERR_RESOURCE_NOT_FOUND` | Dispatch target does not exist. The message lists what is available — a scoped resource registered into the wrong context is the usual cause. |
| `ERR_RESOURCE_NOT_INVOKABLE` / `ERR_RESOURCE_NOT_RUNNABLE` | The target exists but has no `invoke`/`run`. Check the kind's capability against the slot. |
| `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID` | The values passed to, or produced by, a call do not satisfy the declared `inputType`/`outputType` — or a native function's `params` / `returns`, or an HTTP request's text at a slot whose value type's encoding does not read it. Raised as structured errors, so they can be caught — but never declared by a kind. |
| `ERR_CONTRACT_UNRESOLVABLE` | A declared contract could not be resolved to a schema. |
| `ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE` | An `!interpolate` hole evaluated to null, a list or a map, which CEL's `string()` cannot turn into text. The message names the hole and the type found. Declare `outputType` on the resource producing the value so `telo check` sees its type, or guard it inside the hole. |
| `ERR_INVOKE_CANCELLED` | The invoke was cancelled — a shutdown signal, a disconnected client, or an elapsed deadline. |
| `ERR_EXECUTION_FAILED` | A dispatch failed; the underlying error is attached as its cause. |
| `ERR_INVALID_VALUE` | A resource reference string is not `<Kind>.<Name>`. |
| `ERR_TYPE_NOT_FOUND` / `ERR_TYPE_VALIDATION_FAILED` | A named type is not in the registry, or its rule evaluation threw. |
| `ERR_NETWORK_UNREACHABLE` | An outbound fetch could not reach its host. |
| `ERR_FATAL` | Unrecoverable — re-thrown immediately rather than retried by the init loop. |
| `ERR_STEP_TIMEOUT` | A step's `timeout:` elapsed before its target returned. |
| `ERR_STEP_NAME_REQUIRED` | A step reached a durable journal with no `name:`. The shared step schema requires one, so a manifest cannot trigger this; only code assembling steps programmatically can. |
| `ERR_ZONE_REQUIRED` | A resource that must be reached through another's body (a statement outside its transaction) was dispatched with no such zone on the ambient context. The message names the required zone and, where correlated, the instance it must be on. The static form is `ZONE_REQUIREMENT_UNSATISFIED`. |
| `ERR_ZONE_ANNOTATION_MISSING` / `ERR_ZONE_UNRESOLVED` | A controller opened or required a zone its schema does not declare, or the annotation's kind could not be resolved — the controller and its schema disagree, a module-authoring bug. |
| `ERR_CAUSE_CYCLE` / `ERR_CAUSE_CHAIN_TRUNCATED` | Not errors you can raise: markers the log encoder writes into a serialized error whose `cause` chain refers to itself, or exceeds the depth limit. |
| `ERR_PLAIN_JSON_UNWRITABLE` | A value cannot be written as plain JSON for a reader outside Telo (an HTTP body, a CLI document): a map two of whose keys share one text (`1` and `"1"`), a map key that is no CEL map key, or a value containing itself. |

### Functions

| Code | What it means and what to do |
| --- | --- |
| `ERR_FUNCTION_UNRESOLVED` / `ERR_FUNCTION_NOT_EXPORTED` / `ERR_FUNCTION_NOT_CALLABLE` | A module call a resource makes does not bind — raised when that resource is created, before any of its expressions evaluate, including a call in a branch that never runs. The static forms are `FUNCTION_UNRESOLVED`, `FUNCTION_NOT_EXPORTED` and `FUNCTION_NOT_CALLABLE`. |
| `ERR_FUNCTION_ARITY_MISMATCH` | A call passed a number of arguments the function's parameter list does not accept. A structured error a `try:` can catch; outside the ambient union. |
| `ERR_FUNCTION_CONFIG_INVALID` | A Rust function's resource configuration, already accepted by its kind's schema, does not deserialize into the function's `Config` type, so the instance is not created. The kind's schema and the Rust type disagree; the message carries serde's reason. |
| `ERR_FUNCTION_FAILED` | A function failed while its expression evaluated. `data` carries `function` (the call as written), `message` and the thrown `code` when there was one — `ERR_CONTROLLER_PANIC` for a Rust function that panicked. Ambient: `try:` and `catches:` catch it and no kind declares it; a retry policy does not re-attempt it, since re-evaluating a synchronous call with the same arguments does not recover. |
| `ERR_FUNCTION_ASYNC` | A native function's `call` returned a promise. A function is evaluated inside a CEL expression, which cannot wait: make `call` synchronous and do asynchronous setup in `create`. A `call` declared `async` is refused when the instance is created, as `ERR_CONTROLLER_INVALID`. |

### Durable execution

| Code | What it means and what to do |
| --- | --- |
| `ERR_DURABLE_SUSPENDED` | **A signal, not a failure.** A durable body parked (`Durable.Sleep`, `Durable.Await`, a long retry backoff) and unwinds to the workflow that owns the run. It passes through `try:` / `catches:` / retry untouched; if you see it as a caught error, something in the path swallowed it. |
| `ERR_DURABLE_SUSPENSION_SWALLOWED` | A body parked but the signal never reached the workflow — a script's `catch`, a custom composer. The run cannot be resumed correctly. Let the signal propagate. |
| `ERR_DURABLE_SUSPEND_FORBIDDEN` | A wait was reached inside a region that promises nothing inside it waits (`noSuspend`) — the runtime half of `ZONE_ATTRIBUTE_VIOLATED`, for paths the static check could not trace. |
| `ERR_DURABLE_UNJOURNALABLE_VALUE` | A value a durable run records — a step's result, a decision, a delivered payload, a scheduled run's inputs, the run's result — is outside the CEL value domain: a live stream, a class instance (including one offering `toJSON`, which would come back as a plain object), or a function. `data.path` names where it was recorded and `data.valuePath` the offending node inside it. Collect what you need into plain values inside the step. Static form, for streams only: `DURABLE_UNJOURNALABLE_RESULT`. |
| `ERR_DURABLE_ENTRY_UNDECODABLE` | A recorded value was written by a codec version this runtime does not read (`data.version`, beside `data.reads`). It is refused rather than read for the parts that look familiar. Continue the run on a runtime new enough to read its journal. |
| `ERR_DURABLE_JOURNAL_CORRUPT` | A recorded value declares the current codec version but is not a frame that codec reads — its text is not a string, or its frame does not decode (the decode failure is the `cause`). `data.run` and `data.path` name the record. Something outside the journal rewrote it. |
| `ERR_DURABLE_TARGET_UNENCODABLE` / `ERR_DURABLE_TARGET_UNDECODABLE` | A step target could not be written into, or read back from, the journal's wire form — a `with:`-scoped target whose scope cannot be identified, or a record from an incompatible version. |
| `ERR_TYPED_FRAME_UNENCODABLE` | A value handed to a typed frame — the form a journal entry and a native function's arguments and result cross in — is outside the CEL value domain: a class instance (including one offering `toJSON`), a function, `undefined`, a map with a key CEL cannot hold or two keys CEL reads as one, a list carrying a property beside its items, or a cycle. `data.path` is the JSON Pointer of the offending node. |
| `ERR_TYPED_FRAME_UNDECODABLE` | A typed frame is not valid JSON, names a tag outside the closed vocabulary, carries a payload not in its canonical form, a map key CEL cannot hold, a repeated key, or text that is not Unicode. `data.path` is the JSON Pointer inside the frame. A journal reports it for a corrupted entry. |

### Observed state

| Code | What it means and what to do |
| --- | --- |
| `ERR_OBSERVED_STATE_BEFORE_START` | `ctx.setStatus()` was called before the resource started. `init()` performs no I/O, so nothing is observed there. |
| `ERR_OBSERVED_STATE_UNDECLARED` | The kind declares no `status:` block. |
| `ERR_OBSERVED_STATE_INVALID` | The reported value does not match the declared `status:` schema. |
| `ERR_OBSERVED_STATE_KEY_COLLISION` | A kind that declares `status:` also returned a flat `status` field. |
| `ERR_OBSERVED_STATE_UNAVAILABLE` | A read of `status.<field>` that cannot be answered — not started, still running, or run without reporting that field. The message says which. |

### Controllers and artifacts

| Code | What it means and what to do |
| --- | --- |
| `ERR_CONTROLLER_NOT_FOUND` | No controller candidate could be loaded for the kind, on this host. |
| `ERR_CONTROLLER_NOT_LOADED` | A kind resolved but its controller was never registered. |
| `ERR_CONTROLLER_INVALID` | The controller bundle loaded but has no such export — a module packaging bug. For a callable kind the message names the function (`Function '<kind>/<name>': …`): its controller has no `create`, or `create` returned an instance with no synchronous `call(args)`. |
| `ERR_CONTROLLER_BUILD_FAILED` | Building a controller from source failed (the build's own error follows). |
| `ERR_MODULE_LAYER_INTEGRITY` | A layer's contents do not hash to the digest the pinned manifest records. Treat as tampering or corruption; see [Security](/deploy/security). |
| `ERR_MODULE_LAYER_INVALID` / `ERR_MODULE_FILES_UNAVAILABLE` | A layer contains an illegal entry, or a module-relative file — a `ctx.resolveModuleFile` or `ctx.resolveControllerFile` path or an `!include-*` embed — could not be handed over: the module was fetched from a registry with no layer index (usually published before layered artifacts — republish it), or, in a source checkout, a module file (one an `assets:` pattern selects, or a notice) a `sources:` entry stages at or beneath the path is unpinned or could not be staged — the message says whether its archive could not be fetched, does not hold the pinned file, or staging failed otherwise (a lock, a write), and names the URL — or the module's `sources:` block does not read. Run `telo release stage --pin` for an unpinned entry and `telo check` for an unreadable block. |
| `ERR_NATIVE_FILE_UNAVAILABLE` | `ctx.resolveNativeFile(name)` found no file: the module declares no native file of that name, no entry matches this host (the message names the host tuple and every tuple shipped), the artifact ships no native layer for the matching entry, or — in a source checkout — the staged file is unpinned or could not be staged, the module's `sources:` block does not read, or a checked-in link leads outside the module. Run `telo release stage --pin` for an unpinned entry and `telo check` for an unreadable block; otherwise the module needs a release for this host. See [Native files](/extend/native-files). |
| `ERR_STAGED_FILE_INVALID` | A prebuilt controller candidate in a source checkout — a `pkg:telo/local/napi` addon on the Node kernel, a `pkg:telo/local/dylib` library on the Rust kernel — is staged by a `sources:` entry, but the entry carries no pin, its archive does not hold the pinned file (the member is absent, or its bytes or execute bit differ from the pin), or the module's `sources:` block does not read. Run `telo release stage --pin` or `telo check`; the candidate is not skipped in favour of the next one. An archive that could not be fetched is not this error: that candidate falls through. |
| `ERR_STAGING_FAILED` | Staging a prebuilt controller candidate's file in a source checkout failed for a reason that is neither the network nor the pin: the per-archive lock under the module's `.telo/staging/` could not be taken (another process held it past the wait limit), the file could not be written, or its path runs through a symbolic link on disk. The message carries the cause; the candidate is not skipped in favour of the next one. |
| `ERR_MODULE_LAYER_FETCH_FAILED` | Rust kernel: a layer blob could not be pulled from the registry, or is not a readable tar.gz. The message names the ref and blob; check the registry is reachable and the module was published completely. |
| `ERR_MODULE_LAYER_EXTRACT_FAILED` | Rust kernel: a verified layer could not be written into the module's cache directory (permissions, disk, a path already occupied by a directory). The message names the entry; fix the directory, or remove it and run again. |
| `ERR_DIRECTORY_LOCK_FAILED` | Rust kernel: the cache directory lock (`<dir>/.lock`, shared with the Node kernel) could not be created, reclaimed or waited for. The message names the lock file; remove it if no other Telo process is running. |
| `ERR_LOG_SINK_ON_FULL_UNSUPPORTED` | The runtime half of `LOG_SINK_ON_FULL_UNSUPPORTED`: a sink was configured with an `on_full:` policy it cannot honour (`block` on a sink that cannot block). Use `drop_new` or `drop_old`. |

### Shutdown

| Code | What it means and what to do |
| --- | --- |
| `ERR_TEARDOWN_FAILED` | One or more resources threw during teardown. The cascade still completed — failures are aggregated, not fatal to the rest. |

## See also

- [Catching errors before they run](/learn/static-analysis) — the workflow, the
  debugging flags, and what static analysis can and cannot find.
- [Running in production](/deploy/production) — exit codes and signal handling.
- [Resource lifecycle](/reference/kernel/resource-lifecycle) — init ordering and
  failure classification.
- [Style guide](/learn/style-guide) — naming rules that prevent a whole class
  of these.
