---
sidebar_label: CEL Functions
slug: /extend/cel-functions
description: "Declare functions a module's CEL expressions call — written in CEL as Telo.Function, or natively in TypeScript or Rust as a callable kind — with typed signatures, derived determinism, and export control."
---

# CEL functions

An expression that recurs across a module — a price with VAT, a signature check,
a staleness test — is a function. Telo lets a module declare it once, as a
resource, and call it from any CEL expression through a module name:

```yaml
price: !cel "Self.withVat(item.net)"
signed: !cel "Crypto.hmacSha256(secrets.key, request.body)"
```

A function is a resource whose capability resolves to `Telo.Callable`. It has a
signature — `params` and `returns` — that `telo check` types every call against,
and a lifetime like any resource: it is created before anything that calls it,
rebuilt when it changes, and torn down with the module.

## Writing a function in CEL

`Telo.Function` is the built-in callable whose result is a CEL expression over its
parameters:

```yaml
kind: Telo.Function
metadata:
  name: withVat
  description: Adds VAT to a net price at the given rate.
params:
  - name: net
    schema: { type: number }
  - name: rate
    schema: { type: number, default: 0.24 }
    optional: true
returns:
  schema: { type: number }
body: !cel "net * (1.0 + rate)"
```

- **`params`** is ordered, because a call is positional (`Self.withVat(10.0)`),
  and named, because a native function receives one object keyed by those names.
  Optional parameters come last. An omitted optional parameter takes its schema's
  `default`, and is `null` when it declares none — so inside the body it is
  nullable. `nullable: true` admits `null` as an argument, which is different
  from omitting one.
- **`schema`** is JSON Schema, and names a shape with `!ref`
  (`schema: !ref Money`) — never a bare string.
- **`body`** sees its parameters, the CEL catalog and the functions it can call,
  and nothing else: no `variables`, `resources`, `steps` or `request`. A function
  computes from its arguments.
- **No `deterministic:` key.** A `Telo.Function`'s determinism is derived from
  what its body calls (below); declaring it is a schema violation.

## Calling a function

A call's receiver is a module name, and it names a resource of that module:

| Written | Names |
| --- | --- |
| `Self.fn(…)` or `<ModuleName>.fn(…)` | a function the module itself declares |
| `<Alias>.fn(…)` | a function the imported library lists in `exports.resources` |

A library exports a function exactly as it exports any instance:

```yaml
kind: Telo.Library
metadata:
  name: Billing
exports:
  resources: [withVat]
```

`telo check` refuses a call that reaches no resource (`FUNCTION_UNRESOLVED`), one
the library does not export (`FUNCTION_NOT_EXPORTED`), a resource that is not a
function (`FUNCTION_NOT_CALLABLE`), the wrong number of arguments
(`FUNCTION_ARITY_MISMATCH`) and an argument its parameter does not admit
(`FUNCTION_ARGUMENT_MISMATCH`). A call's result is typed as the function's
`returns`, so `Self.quote(x).total` is checked against the declared shape.

Three things a call cannot do:

- **Recurse.** A call is a dependency of the resource making it, so a body calling
  itself — directly or through another function — is a dependency cycle
  (`DEPENDENCY_CYCLE`).
- **Run where nothing binds functions** — an Application's `logging:` block, read
  while the application loads, or a `Telo.JsonSchema` rule `condition`, evaluated
  against a value alone (`FUNCTION_CALL_UNBOUND`).
- **Be read as a value.** A function publishes no reading, so it is not in the
  `resources` scope.

`telo cel functions <manifest>` lists the functions a manifest can call, with
their signatures and derived determinism.

## How a call resolves

This is the rule every CEL engine hosting Telo implements, so an expression means
the same thing to `telo check`, the editor and every kernel.

1. **The name set.** For each declaring module, the names a call's receiver may
   be are `Self`, the module's own `metadata.name`, each `imports:` alias and
   `Telo`. A partial file uses the names of the module that includes it. A name
   in this set is never a root identifier of the expression, and is reserved:
   a binding, comprehension variable or `cel.bind` name cannot take it
   (`BINDING_NAME_RESERVED`).
2. **Resolution at compile.** A receiver-style call whose receiver is a plain
   identifier in the name set is a module call. When the expression is compiled
   the call is rewritten, on the parsed tree, into a late-bound call dispatched
   through a context key no manifest can spell — so a call cannot reach past the
   export gate or the dependency edge. The compiled value carries the list of
   qualified calls it makes. Spans and trace text stay as written.
3. **Binding per scope, at creation.** When a resource is created — before any of
   its expressions evaluate, including a call in a branch that never runs — every
   call it makes is bound, once per module scope per qualified name. A template
   body binds in the module that defined the template. Two isolated imports of a
   library bind twice; a shared one binds once. A binding that cannot be made
   fails the creation (`ERR_FUNCTION_UNRESOLVED`, `ERR_FUNCTION_NOT_EXPORTED`,
   `ERR_FUNCTION_NOT_CALLABLE`); a callee not yet created defers the caller as a
   pending reference does.
4. **Evaluation.** Positional arguments map onto the parameter names, defaults
   fill omitted optional parameters, and declared scalars are normalized. Whatever
   the function throws fails the expression as `ERR_FUNCTION_FAILED`, carrying the
   function's name and the thrown code — an ambient error `try:` and `catches:`
   catch, and a retry policy does not re-attempt.

## Determinism

Whether a function returns the same result for the same arguments matters in four
places: inside a durable region declared `idempotent` (`DURABLE_NONDETERMINISM`),
in a field evaluated once at startup (`CEL_NONDETERMINISTIC_IN_COMPILE_FIELD`), in
a resource or referrer rule condition (`RESOURCE_RULE_INVALID`), and at a slot
whose callable abstract declares `deterministic: true`.

A `Telo.Function` is **deterministic exactly when everything it calls is** —
catalog functions and other module functions alike — and **host-free** on the
same terms. Every message about it names the chain to the call that decided it:

```
Billing.isStale → now()
```

An edit to a body a rule calls changes the verdict with no edit to the rule.

## Native functions

When a function needs code — a cryptographic primitive, a parser, a native
library — write a callable **kind** with a controller, and declare instances of
it:

```yaml
kind: Telo.Definition
metadata:
  name: Hmac
  description: Signs a message with HMAC under a key, using the configured digest algorithm.
capability: Telo.Callable
deterministic: true
schema:
  type: object
  properties:
    algorithm: { type: string, enum: [sha256, sha512] }
  required: [algorithm]
params:
  - name: key
    schema: { type: string }
  - name: message
    schema: { type: string }
returns:
  schema: { type: string }
controllers:
  - pkg:telo/local/js?path=./nodejs/crypto.mjs&local_path=./nodejs/src/index.ts#Hmac
---
kind: Self.Hmac
metadata:
  name: hmacSha256
algorithm: sha256
```

**`deterministic: true` is a promise, and nothing checks it.** The runtime cannot
inspect a controller's code, so a native function is deterministic only where the
kind supplying its controller says so — and absent means false. Make the promise
only when the result depends on nothing but the arguments and the instance's
configuration: no clock, no randomness, no I/O. A native function is always
host-backed, so a rule condition never calls one.

### Node

```ts
import { createHmac } from "node:crypto";
import type { FunctionController, ResourceManifest } from "@telorun/sdk";

interface HmacResource extends ResourceManifest {
  algorithm: "sha256" | "sha512";
}

export const Hmac: FunctionController<HmacResource, { key: string; message: string }, string> = {
  async create(resource) {
    return {
      call: ({ key, message }) => createHmac(resource.algorithm, key).update(message).digest("hex"),
    };
  },
};
```

- `create(resource, ctx)` may be asynchronous. `ctx` offers only
  `resolveControllerFile`, `resolveNativeFile`, `log` and `effect`; register what
  `create` allocates with `ctx.effect(…).perform()` so teardown and reload
  release it.
- `call(args)` is **synchronous** — it runs inside one CEL expression. A `call`
  typed to return a promise fails the TypeScript build; one declared `async` is
  refused when the instance is created (`ERR_CONTROLLER_INVALID`), and a promise
  returned at runtime is `ERR_FUNCTION_ASYNC`.
- `args` is one object keyed by parameter name, with defaults filled and declared
  scalars normalized; values are CEL values — a `bigint` for an integer, a `Date`
  for a timestamp, a `Duration`, a `Uint8Array` for bytes. Arguments that do not
  satisfy `params` are `ERR_INPUT_INVALID`, a result that does not satisfy
  `returns` is `ERR_OUTPUT_INVALID`.

### Rust

```rust
use serde::Deserialize;
use telorun_sdk::{function, Function, FunctionContext, Result, Timestamp, Value};

pub struct IsBefore;

#[derive(Deserialize)]
pub struct Instants { a: Timestamp, b: Timestamp }

#[function(entry = "is_before")]
impl Function for IsBefore {
    type Config = Value;
    type Args = Instants;
    type Output = bool;

    fn create(_config: Value, _ctx: &dyn FunctionContext) -> Result<Self> { Ok(IsBefore) }
    fn call(&self, args: Instants) -> Result<bool> { Ok(args.a < args.b) }
}
```

```yaml
controllers:
  - pkg:cargo/<crate>?local_path=./rust#is_before
```

Arguments and results cross as typed frames, so `Timestamp`, `Duration`, `Bytes`
and `Uint64` keep their CEL type. `Drop` releases what `create` allocated. A panic
fails the expression as `ERR_FUNCTION_FAILED` carrying `ERR_CONTROLLER_PANIC`.

## Functions in slots

A kind can hold a function the way it holds any resource — through a reference
slot constrained to a **callable abstract** that states the signature:

```yaml
kind: Telo.Abstract
metadata:
  name: Signer
capability: Telo.Callable
params:
  - name: key
    schema: { type: string }
  - name: message
    schema: { type: string }
returns:
  schema: { type: string }
```

A function satisfies the slot by `extends: Self.Signer`, or structurally: its
result must be readable as the abstract's (covariant), the abstract's arguments
must be acceptable to it (contravariant), by position and by name, and — where
the abstract declares `deterministic: true` — its derived determinism must hold.
A bare `Telo.Callable` constraint says nothing about the signature and is refused
(`X_TELO_REF_CALLABLE_UNTYPED`).

The holding controller calls `call(args)` with one object keyed by parameter name.
Every function's `call` — written in CEL or natively — is bound to its own
signature when it is created: defaults are filled, arguments that do not satisfy
`params` are `ERR_INPUT_INVALID`, a result that does not satisfy `returns` is
`ERR_OUTPUT_INVALID`, and anything else the function throws is
`ERR_FUNCTION_FAILED` naming it as `<kind>/<name>`.

## Why a function is shaped this way

- **A function is a resource.** It is a named value with an owner, configuration,
  a lifetime and a reload story, and resources already give it one namespace, one
  export gate, one reference grammar, init order and a box in the editor. A
  compile-eval field computed with a function is rebuilt when that function
  changes, because the call is a dependency edge; an edit inside an imported
  library still restarts the application, as every library edit does.
- **Not an invocable.** `invoke` is asynchronous, traced and zone-tracked per
  dispatch, so it cannot run inside a synchronous CEL expression.
- **One way to write each kind of function.** `Telo.Function` holds a CEL body and
  nothing else; native code is a callable kind plus its instances, so no document
  is half kind, half instance.
- **Resolved on the parsed tree, typed per site, bound per scope.** A signature
  belongs to a module and an implementation to a scope: two isolated imports share
  one compiled expression and hold two instances. Rewriting the source text would
  move editor positions off what the author wrote.
- **Held as a `dependency`, never a `call`.** `call(args)` receives no context, so
  no zone, cancellation or trace reaches it, and claiming it runs inside the
  holder's invocation would assert a containment that cannot exist.
- **A body sees only its parameters.** That is what makes it typable from its
  signature, rebuilt exactly when something it calls changes, and evaluable by
  `telo check` inside a rule condition.
- **Determinism is derived where it can be and claimed where it cannot.** A flag
  written on something the analyzer can derive is a second source of truth, and a
  default of "pure" on code nobody can inspect would make every check reading it
  unsound with nothing reported. It is also a substitution dimension, so a
  deterministic abstract never accepts an implementation that reads the clock.
- **Types are JSON Schema.** Every contract walk, field check and structural
  comparison already reads it, and a record is an ordinary `Telo.JsonSchema`
  matched structurally. A parameter's schema is not a place for
  `x-telo-sensitive`: a CEL value is never redacted, so secrets stay on contracts
  (`SENSITIVE_ANNOTATION_MISPLACED`).
- **One signature per name.** Omission is `optional`, trailing, taking the
  schema's `default` or `null`; `nullable` is for an argument that genuinely is
  `null`.
- **`create` returns an instance with a synchronous `call`.** A bare exported
  function has no place for asynchronous setup, and process-level state would be
  shared across in-process kernels and two versions of one module, with nothing
  to release it on reload.
- **Native time and byte types in every language.** A Rust function receives a
  `Timestamp`, a `Duration` and bytes rather than text, so no function parses a
  value itself; every non-live value type has one plain encoding, which is what
  lets byte parameters cross into native code.
- **A call is not journaled.** Every decision point of a durable run already
  records its value, and a call inside one expression has no step path of its
  own.

## Declaring a runtime floor

A module whose own `telo.yaml` declares a `Telo.Function` or a
`capability: Telo.Callable` kind uses syntax older runtimes reject; declare the
release that carries it under `requires: telo:` — see
[Declaring runtime requirements](./declaring-runtime-requirements.md).
