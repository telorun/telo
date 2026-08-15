---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
---

A produced value is normalized to the representation its contract declares, so
the declaration is true rather than merely satisfied.

A declared shape says what a value IS, not only what it must pass — the service
a JSON Schema gives an HTTP response serializer. Telo's CEL layer already took
it literally: `type: integer` types as CEL `int`, and a CEL int is an int64. A
controller handing back a plain JS number at such a slot therefore made its own
contract a lie that surfaced nowhere until an expression composed it —
`!cel "steps.call.result.n + 1"` type-checked statically and then died at
dispatch with `no such overload: dyn<double> + int`, which is what pushed
authors to `double(...)` and `int(...)` casts an int64 should never need.

`declaredScalarPaths` (analyzer, browser-safe) reads the declared representation
off a contract schema, and `bindContract` normalizes the produced value along
exactly those paths. It is **representation-driven, not integer-specific**: a
value type is read through the same rule rather than beside it, so a `json`
representation contributes its `base` (`Telo.TcpPort` is an int64 slot) while an
`instance` one replaces the JSON layer — bytes and streams are already their own
representation, nothing converts to them, and the walk stops rather than
descending into a value that is not a plain container. `type: number` is the
symmetric case and normalizes the other way.

Only an EXACT conversion is performed. An integral number becomes an int64; an
int64 becomes a double only when the round-trip is lossless. A fractional number
at an integer slot, a string, a magnitude no double can hold — all arrive
unchanged, so a value that genuinely violates the contract is still rejected
rather than quietly repaired, and a 64-bit integer is never truncated to reach a
`number` slot. Bounded by the schema, so a contract declaring no such scalar
walks nothing at dispatch.

**Outputs only, deliberately.** Normalization states what a value is to whoever
reads it next. On the way out that reader is CEL, which already types the
declaration as `int` — there the declaration and the value genuinely disagree.
On the way in it is a controller written in the host language, where handing it
an int64 would change the authoring surface of every module rather than repair a
false declaration.

**This changes what crosses a module boundary.** A controller that reads another
resource's declared-integer output with `Number.isInteger(...)`, `setTimeout`, or
plain arithmetic now receives an int64 and must accept both representations —
`integerInput` (new, `@telorun/sdk`) is that read. Modules in this repo are
fixed; a published module doing the same breaks until republished.
