---
description: "v1.0 spec: the invocation contract — how a resource's declared inputType/outputType is resolved, bound, default-filled and enforced at dispatch, and how contract violations are reported"
---

# Telo Invocation Contract Specification (v1.0)

## 0. Status, scope, and how to read this

This is a **runtime conformance specification**. It defines what a Telo runtime
does with a resource's declared invocation contract: which declaration applies,
when it is bound, which dispatch verbs it governs, how defaults are filled, what
is validated, and how a violation is reported.

It is normative because the behaviour is only partly expressible in prose plus
one implementation. `useDefaults` is a non-standard AJV extension with
implementation-defined behaviour under `anyOf` and nesting; two runtimes that
guess differently would accept different manifests and fill different values, and
a manifest that works on one would silently misbehave on the other.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
**MAY**, and **RECOMMENDED** are to be interpreted as described in RFC 2119.

**In scope:** contract resolution along `extends`, the mapping requirement,
binding and the verbs it covers, default-fill semantics and traversal order,
validation and what it exempts, error codes and their status against `throws:`
unions, and ordering relative to the dispatch span.

**Out of scope:** the static checks a checker performs (they are diagnostics, not
runtime behaviour), the `telo#Type` reference grammar (see the type-field section
of `CLAUDE.md`), and how a controller implements the work between the two
validations.

## 1. What a contract is

A resource's **invocation contract** is two independently-declared schemas:

- **`inputType`** — what a caller sends to `invoke()`.
- **`outputType`** — what `invoke()` or `provide()` returns.

Both are `telo#Type` fields: a bare type name, a `!ref` to a type resource, an
inline `{ kind, schema }`, or a raw JSON Schema. A runtime MUST accept all four
forms wherever a contract is declared.

A `!ref` names a type in the scope of the module that WROTE it — `!ref Money` is
that module's own `Money`, `!ref Types.Money` the one its `Types` import exports —
at kind level and instance level alike. A runtime MUST resolve it to that
declaration, never to whichever loaded module registered a type of the same name.

A contract may be declared on a **kind** (a `Telo.Definition` / `Telo.Abstract`
field) or on an **instance** (a resource that writes the property, which the kind
opts into by declaring it in its own schema). Declaring the property IS the
opt-in; a runtime MUST NOT require any additional annotation.

## 2. Resolution

### 2.1 Layering

For a given direction, a runtime MUST resolve the contract in this order and stop
at the first that yields a schema:

1. the **instance manifest's** own declaration;
2. the **kind's** declaration, resolved per §2.2;
3. **undefined** — the resource has no contract in that direction.

A resource with no contract in a direction MUST NOT have that direction
validated. Absence is the absence of a claim, never a claim of emptiness: a
runtime MUST NOT substitute a closed or empty schema.

### 2.2 Resolution along `extends`

A kind's contract is the **nearest declaration** along its `extends` chain,
self first. A definition that declares one **fully replaces** its ancestor's; a
definition that declares none inherits its ancestor's verbatim, at any depth.

Contracts **MUST NOT** be merged. This differs deliberately from the author-facing
config schema and the observed-state block, which do merge: construction config
and reported state are additive, a call signature is not. Merging a child's
required fields into its parent's produces a union no caller can satisfy, and it
would reject the one thing a child declares a signature FOR — accepting something
different.

Each hop MUST be resolved in the scope that **declared** the definition the kind
was read off: `extends` aliases are lexical, and a `telo#Type` reference goes
through import aliases, so a chain crossing module boundaries re-scopes at every
hop.

### 2.3 The mapping requirement

A definition that declares its own contract while **inheriting its controller**
(it `extends` a concrete kind, declares no own controller or template body) MUST
also declare the bridging mapping:

| declared      | required mapping |
| ------------- | ---------------- |
| `inputType`   | `inputs:`        |
| `outputType`  | `result:`        |

Without it the inherited controller — which understands only the shape it was
written for — would receive the child's shape unchanged. A runtime MUST NOT apply
an unmapped replacement silently; a checker MUST reject it.

A definition with its own controller or template body is exempt: its controller
IS the implementation of whatever it declares, so there is nothing to bridge.

Substitutability is unaffected by replacement. `extends` decides which slots
accept a resource; it never carried the dispatch contract. Whether a particular
slot may hold a resource whose contract differs from the slot's declared kind is
a wiring question, decided per slot by whether the caller can supply the
arguments at all.

## 3. Binding

### 3.1 Where

A runtime MUST bind a resource's resolved contract to its dispatch entry point at
**instance creation**, such that **a resource instance is never observable in an
unbound form**.

Binding at creation rather than at each handoff is normative because the handoffs
cannot be enumerated safely: a reference reaches a consumer through injection into
its configuration, through explicit reference resolution, through scope handles,
and through the dispatch chokepoint, and a consumer that holds the instance may
dispatch it directly. Enforcing at one of those and not the others leaves the
contract unenforced on the others without any signal that it is.

How a runtime expresses the binding is unconstrained — a wrapped entry point, a
struct field, a decorator. What is normative is the invariant above, not any
particular mechanism.

### 3.2 Which verbs

| verb                | input side | output side |
| ------------------- | ---------- | ----------- |
| `invoke(inputs, …)` | bound      | bound       |
| `provide()`         | n/a        | bound       |
| `run(…)`            | not bound  | not bound   |

`provide()` takes no caller arguments, so it has no input side; its result is
validated exactly as an invocable's, by the same path.

`run()` is parameterless and returns nothing, so there is nothing to fill
defaults into and no result to validate. A runtime MUST NOT extend the runnable
signature to carry inputs, and MUST NOT smuggle values through the dispatch
context: that would make defaults a property each controller opts into rather
than a runtime guarantee. A resource whose resolved contract requires any input
is therefore unsatisfiable at a run dispatch site, and a checker MUST reject that
wiring.

### 3.3 Argument forwarding

A bound entry point MUST forward **every** argument it receives. The contract
concerns the first argument only; later parameters carry the dispatch context
(cancellation, tracing) and belong to the caller and the callee. A binding that
declares only the inputs parameter silently drops that context — a detached body
would never observe cancellation, and anything holding a resource across it would
never be released.

### 3.4 Composition with an inherited mapping

Where a child both inherits a contract-bearing parent and declares its own
contract with a mapping (§2.3), the bindings compose by position:

1. the child's contract validates the caller's inputs;
2. `inputs:` maps them onto the parent's call;
3. the parent's contract validates the mapped values;
4. the inherited controller runs;
5. the parent's contract validates its result;
6. `result:` maps it back;
7. the child's contract validates the mapped result.

A runtime MUST NOT introduce a distinct wrapping object for this case. The parent
instance is returned as-is and the mapping is bound to it, so the child remains a
parent instance for every non-dispatch purpose — lifecycle, reported state, and
any member a consumer reaches for.

## 4. Dispatch

### 4.1 Order

On a bound `invoke()` a runtime MUST, in this order:

1. produce the effective inputs (§4.2);
2. validate them against the input contract, if one resolved;
3. dispatch;
4. validate the result against the output contract, if one resolved.

Validation MUST happen inside the dispatch span, so a violation is attributed to
the call it belongs to.

### 4.2 Defaults

Default-filling and input validation are **one pass** over the effective inputs.

The effective inputs MUST be a copy that is **deep along every path a default can
be written to** and MAY share structure elsewhere. A flat shallow copy is
non-conforming: defaults are written at every level they are declared, so a
nested default would mutate the object the caller still holds. The set of such
paths is derivable from the compiled schema, so the copy is bounded by the
schema's defaults rather than by the size of the payload.

A default MUST be applied only where the property is absent. An explicit `null`
is a value, not an absence.

Defaults inside composition keywords (`anyOf`, `oneOf`) are **NOT RECOMMENDED** in
a contract. Which branch a validator evaluates — and therefore which default it
applies — is implementation-defined across validators, so a contract relying on
it would fill different values on different runtimes for the same manifest. A
runtime MUST apply defaults deterministically for a given schema and input, and
SHOULD document the branch order it follows; authors who need a default on a
branching shape SHOULD lift it to the enclosing `properties` instead, where the
rule above is unambiguous.

### 4.3 Numeric representation

A runtime whose expression language produces a wide-integer type distinct from
its JSON number type (CEL evaluates an integer literal to one) MUST validate a
view in which those values are rendered as ordinary numbers, and MUST dispatch
the original values. A validator that does not recognise the wide type would
otherwise reject every computed integer reaching a declared `integer` input, for
a reason no author can act on — while converting the dispatched value would cost
a controller the full range it may need.

Defaults filled into that view are ADDITIVE, so a runtime MUST carry back only
the keys the fill added; a key the caller supplied keeps its original value. The
carry-back MUST reach values nested inside arrays: a schema may declare a default
under `items`, and stopping at the array boundary drops that fill silently.

### 4.4 Serializing a wide integer

Where a value crosses a JSON boundary — a response body, a record frame, a
persisted value — a wide integer MUST be emitted as its **exact decimal digits**.
JSON places no precision limit on a number, so this is lossless, and it is what a
schema-driven serializer already produces for a declared `integer`; a runtime with
two serialization paths MUST NOT let them disagree at any magnitude. A runtime
MUST NOT satisfy this by converting to its JSON number type, which silently loses
precision beyond 2^53, and MUST NOT emit a quoted string, which changes the type a
receiver sees.

How a runtime achieves this is its own affair: the Node kernel installs
`BigInt.prototype.toJSON` over `JSON.rawJSON` at boot, a runtime whose integers
are already a JSON number type needs nothing.

Two destinations are NAMED exceptions, because their own wire formats mandate
otherwise and both are read by a receiver that cannot hold the value:

- the `otlp` log encoding, whose 64-bit fields are quoted decimal strings
  (`kernel/specs/logging.md` §11.3);
- the `json` log encoding, which degrades a value beyond the safe-integer range
  to a decimal string for the same reason.

A runtime MUST NOT extend this list to a general-purpose boundary. An exception
is a property of the destination format, never of the value.

### 4.5 What validation exempts

Validation MUST skip every node whose declared value type is `live`, **in both
directions**, wherever that node appears — a property, an array item, a union
branch. Live values travel on inputs as much as on results, and the value at such
a node is a live object, not data: traversing it is the same defect as walking a
live resource instance that occupies a declared reference slot.

Exemption is a property of the TYPE, never of a position: a rule that skipped
only a marked PROPERTY would leave an array-of-streams element constrained even
while descending into it. It is also exemption from VALIDATION and never from
TYPING — a live type's declared type arguments remain visible to every static
check that reads them.

Validation MUST NOT descend into reference-typed properties for the same reason.

### 4.6 Declared scalars and plain-encoded text

A produced value MUST be normalized, along exactly the paths the resolved
`outputType` declares a scalar at, to the representation that declaration names:
a declared `integer` (and every `json` value type carrying the CEL type `int`) to
the runtime's wide integer, a `number` to its JSON number, and a value type
carrying the CEL type `uint` to its unsigned integer. Only an EXACT conversion is
performed — a fractional number at an integer slot, or a magnitude the target
representation cannot hold, MUST arrive unchanged so the value is rejected rather
than quietly repaired. On the way out the next reader is the expression language,
which already types the declaration. On the way in the controller MUST receive its
arguments as the call site produced them — it is host-language code — but wherever
the resource evaluates an expression over them, `inputs` MUST be read normalized
along the resolved `inputType`'s declared scalar paths, without rewriting the value
the controller holds. A transport reading a value from outside the runtime against
a declared schema (a request body, query, params or headers) MUST normalize it the
same way before an expression reads it.

A value type whose representation is an INSTANCE holds that instance in both
directions. Text is read into one only where the value arrives from outside the
runtime, and a conforming runtime MUST decode it at exactly these sites, each
against the schema the site resolves to:

- a resource's own configuration, against its kind's schema;
- an Application `variables:` / `secrets:` env value, and the `default:` standing
  in for an unset one, against that entry's residual schema;
- every slot a resource writes whose schema comes from ELSEWHERE — a call's
  argument map (a step's `inputs:`, the map a reference slot names through its
  `inputs:` pointer, a template definition's top-level `inputs:`, a boot target's
  inline step), an `x-telo-schema-from` slot and an `x-telo-value-schema-from`
  slot — decoded when the resource holding them is CREATED, not per dispatch;
- a value a transport receives — an HTTP request's body, query, path parameters
  and headers — against the schema its route declares, before the handler sees
  it. The runtime offers controllers this decoding as a context service
  (`ResourceContext.readPlainEncoded` in Node), which also refuses text the
  encoding does not read with `ERR_INPUT_INVALID`; a transport documents and
  validates such a slot as the TEXT a client sends (`type: string, format:
  date-time` for a timestamp).

The decoding MUST use the type's declared plain encoding and nothing else, and
text the encoding does not read MUST be left as written so the slot's own
assertion refuses it — with the same message the static checker produces —
wherever the runtime validates that slot: a configuration at creation, an
argument map at its dispatch. A slot whose schema is DERIVED from another kind's
(`x-telo-schema-from`, `x-telo-value-schema-from`) is decoded at creation and
asserted statically only, since no runtime reader validates a slot against a
schema borrowed from another kind. A COMPUTED value is never decoded (it must
already be the instance), and neither is text an embedding tag produced: a
runtime MUST decode before it resolves embeds, so a file's contents are never
read as an encoding.

A HOST PATH (`Telo.HostPath`, a `json` value type declaring `fromHost`) is
absolute wherever it is held, and the `x-telo-type` assertion refuses a relative
one — judged host-neutrally, so a POSIX path, a drive-letter path and a UNC path
are absolute on every host. The one site a relative host path is READ is the
Application `variables:` / `secrets:` site above: a conforming runtime MUST
resolve every host path in that value against the entry's `fromHost` anchor
(`working-directory`: the process working directory) before validating it. A
compile-eval expression at a host-path slot is only a placeholder when the
configuration is validated, so its RESULT MUST be refused at creation when it is
relative (`ERR_HOST_PATH_RELATIVE`). `!module-path` resolves to an absolute path
at creation, beside the embeds.

### 4.7 Writing for a reader outside the runtime

A value written where the reader is not a Telo runtime — a transport body and its
OpenAPI document, a log line (`json`, `pretty`, `otlp`), a debug-wire trace
payload, a runner session event, a CLI JSON document — MUST be written in the
PLAIN encoding, keyed on the value, and MUST NOT carry the typed frame's `$telo`
tag (`durable-execution.md` §6), whose readers are Telo runtimes alone:

- a timestamp as RFC 3339 text in UTC, a duration as seconds (`"5400s"`), bytes
  as base64url without padding — each value type's declared `encoding`;
- a `uint` as its exact decimal digits, as §4.4 writes an int;
- NaN, +Infinity and -Infinity as the strings `"NaN"`, `"Infinity"` and
  `"-Infinity"` (the protobuf JSON mapping, which OTLP/JSON also follows), and a
  negative zero as `0` (RFC 8785);
- a map whose keys are not all strings as an object keyed by each key's text
  (`1`, `true`). Two keys whose text is one — `1` and `"1"` — MUST be refused
  rather than one of them dropped.

A reader recovers the type from the schema it was promised. Two destinations keep
their own rendering of bytes, because their formats define one: a log record's
`bytes` attribute (base64, or a blob pointer on the debug wire — `logging.md`
§6.1), and a debug-wire payload's byte buffer, offloaded to its blob store.

## 5. Errors

### 5.1 Codes

| code                        | raised when                                              |
| --------------------------- | -------------------------------------------------------- |
| `ERR_INPUT_INVALID`         | inputs did not satisfy the resolved `inputType`           |
| `ERR_OUTPUT_INVALID`        | a result did not satisfy the resolved `outputType`        |
| `ERR_CONTRACT_UNRESOLVABLE` | a declared contract resolved to no schema at all          |

A declared contract that cannot be resolved — a named type that never registered
— MUST raise rather than degrade to "unvalidated". Silently disabling
enforcement is the failure mode nobody notices: every later call passes because
nothing is checking. It is a distinct code because nothing is wrong with the
data; the contract itself is unusable.

A violation MUST be raised as a **structured** error carrying its code, not a
plain one. A runtime that assigns a generic code to unstructured failures would
otherwise make a contract violation indistinguishable from a crash inside a catch
block, leaving an author unable to match it or to rethrow it faithfully.

The message MUST identify the target, the direction, and the offending detail. A
caller several steps away cannot otherwise tell which boundary rejected the value
or which side supplied it.

### 5.2 Status against declared unions

These codes, and `ERR_FUNCTION_FAILED` (§7.3), form an **ambient** union: they are
raised by the runtime for every kind alike, not declared by any kind.

- A `catches:` entry MAY name one, and a checker MUST accept it and MUST
  type-check it against this set exactly as it does a declared code.
- A kind's declared-throws completeness rule MUST NOT count them. Folding them
  into every union would make every bounded catch block incomplete at once.
- A kind MUST NOT declare either code in its own `throws:`. The contract is
  enforced in one place, so declaring it in a second would describe the same
  failure twice and diverge.
- A retry policy MUST NOT re-attempt one: each is a verdict on the shape of the
  call, or on a synchronous call that fails the same way again.

## 6. Conformance

A conforming runtime:

1. resolves contracts per §2, nearest-declaration and never merging;
2. rejects an unmapped replacement on a controller-inheriting definition (§2.3);
3. binds at creation so no instance is observable unbound (§3.1);
4. binds `invoke` and `provide` and not `run` (§3.2);
5. forwards every dispatch argument (§3.3);
6. fills defaults over a copy deep along default-bearing paths (§4.2);
7. validates both directions, exempting streams in both (§4.5), over a view where wide integers read as numbers (§4.3);
8. serializes a wide integer as exact decimal digits at every JSON boundary but
   the named log encodings (§4.4);
9. raises the ambient codes structurally, and excludes them from declared-union
   counting (§5);
10. raises rather than silently skipping when a declared contract resolves to no
    schema (§5.1);
11. binds module calls per module scope at creation, refusing and deferring as
    §7.1 states, and evaluates them as §7.2 and §7.3 state;
12. binds every function's `call` and hands a native function's controller the
    function context, as §7.4 states.

## 7. Module functions

A callable resource (capability `Telo.Callable`) is reached from a CEL expression
through a module name — `Self.fn(…)`, `<ModuleName>.fn(…)` or `<Alias>.fn(…)` —
and never dispatched. This section is what a runtime does with such a call. A
runtime that evaluates no CEL hosts no functions and is exempt.

### 7.1 Binding

A runtime MUST bind every module call a resource's manifest makes when it creates
that resource, before any of the resource's expressions evaluate — including a
call in a branch that never runs. The call resolves in the module whose names it
was written with: for a template body, the module that DEFINED the template.

- `Self.<name>` / `<ModuleName>.<name>` names a resource that module declares;
  `<Alias>.<name>` one the import's library lists in `exports.resources`.
- A name no resource answers to is refused with `ERR_FUNCTION_UNRESOLVED`, a
  declared but unexported one with `ERR_FUNCTION_NOT_EXPORTED`, and a resource
  whose capability does not resolve to `Telo.Callable` along `extends` with
  `ERR_FUNCTION_NOT_CALLABLE`.
- A callee that exists but has not initialized MUST defer the caller as a pending
  reference does (`ERR_LOCAL_REF_PENDING`, or `ERR_CROSS_MODULE_REF_PENDING`
  through an import), and the call is a dependency of the caller for ordering,
  failure attribution, teardown and reconciliation. A body that calls itself,
  directly or through another function, is therefore a dependency cycle, and MUST
  be refused with `ERR_CIRCULAR_DEPENDENCY` before any resource in it is created.

Only a created resource's manifest binds. An expression evaluated outside one — an
Application's `logging:` block, resolved while the application loads, and a type
rule's `condition`, evaluated against the value alone — has no function in scope,
and a call there fails.

A binding is made once per module scope per qualified name — two isolated imports
of one library bind twice, a shared one once — and evaluating a call MUST NOT
resolve it again. When the callee is withdrawn its binding MUST be dropped, and an
evaluation that still reaches it fails as a cancellation.

### 7.2 Arguments

A call site is positional and a callable receives one object keyed by parameter
name, mapped through the signature in force for the callee. An omitted optional
parameter takes its schema's `default`, normalized to the representation the
schema declares (§4.6), and `null` when it declares none. An argument count the
parameter list does not accept MUST be refused with
`ERR_FUNCTION_ARITY_MISMATCH`, never truncated or padded — a structured error a
`try:` step can catch, outside the ambient union.

A `Telo.Function` body MUST be evaluated with its parameters and the module's
function bindings in scope and nothing else: no module inputs, resources, ports,
module metadata, steps or request.

### 7.3 Errors

Whatever a callable throws MUST fail the evaluation as `ERR_FUNCTION_FAILED`, a
structured error whose data carries `function` (the qualified name as written),
the thrown `message`, and its `code` when it had one — except an error that already
is `ERR_FUNCTION_FAILED`, which names the function that actually failed, a
cancellation or a durable suspension, and a function's binding refusals (§7.4),
which all pass unchanged. A holder calling a function it holds through a slot
gets the same classification, with `function` naming the instance as
`<kind>/<name>`.

A failed expression MUST keep a coded error's code and data: a runtime that
rewrapped them into an uncoded failure would make `ERR_FUNCTION_FAILED`
unreachable to a `try:` or a `catches:` list.

### 7.4 Binding a function's call

A runtime MUST bind every callable instance's `call` to the signature in force for
it when it creates the instance — a `Telo.Function` as well as a native function —
so no holder reaches it unbound. An instance a kind inherits its controller for IS
its ancestor's instance, bound when that was created, and is not bound again.

- Before each call it fills defaults (a fresh copy per call) and normalizes
  declared scalars as §7.2 states, and refuses arguments the parameters do not
  admit with `ERR_INPUT_INVALID`. A promise-like result is `ERR_FUNCTION_ASYNC`;
  any other result is normalized and validated against `returns`, refused with
  `ERR_OUTPUT_INVALID`. These three carry `function` in their data and pass
  unwrapped (§7.3). A refused promise that later rejects is reported, never left
  unobserved.
- A CEL call binds its positional arguments to parameter names and hands them to
  the bound call, so a call is bound and validated once.
- An instance with no synchronous `call(args)` MUST be refused with
  `ERR_CONTROLLER_INVALID` naming the function as `<kind>/<name>`.

A callable kind whose definition declares no body field (no property annotated
`x-telo-returns-from`) and does not inherit its controller is NATIVE: its result
comes from its controller's code.

- Its controller's `create(resource, ctx)` MUST receive a function context
  offering exactly `resolveControllerFile`, `resolveNativeFile`, `log` and
  `effect` — no environment, no resource, no I/O. Allocations `create` makes are
  registered through `effect` and join the resource's create frame, so teardown
  and reload release them. A kind inheriting a native controller creates its
  ancestor's instance through the ordinary context, and the ancestor's controller
  receives the function context.
- A controller exporting no `create` MUST be refused with `ERR_CONTROLLER_INVALID`
  naming the function as `<kind>/<name>`.
- Arguments arrive as CEL values: an integer as a 64-bit integer, a timestamp or
  duration as the runtime's native value, bytes as the runtime's byte type.
- A function whose code runs in another language's runtime receives its
  configuration as the resource's plain JSON and its arguments, and returns its
  result, as typed frames (`durable-execution.md` §6), so no value changes type
  crossing that boundary. A panic there fails the evaluation as
  `ERR_FUNCTION_FAILED` carrying the code `ERR_CONTROLLER_PANIC`. Its instance is
  destroyed as the inverse of its creation, at teardown and on reload.
