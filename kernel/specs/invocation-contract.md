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

These codes form an **ambient** union: they are raised by the runtime for every
kind alike, not declared by any kind.

- A `catches:` entry MAY name one, and a checker MUST accept it and MUST
  type-check it against this set exactly as it does a declared code.
- A kind's declared-throws completeness rule MUST NOT count them. Folding them
  into every union would make every bounded catch block incomplete at once.
- A kind MUST NOT declare either code in its own `throws:`. The contract is
  enforced in one place, so declaring it in a second would describe the same
  failure twice and diverge.

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
    schema (§5.1).
