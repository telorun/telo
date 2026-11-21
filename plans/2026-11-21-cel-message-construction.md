---
status: draft
priority: medium
depends-on: []
packages: [cel/nodejs, cel/rust, templating/cel-conformance, templating/nodejs, templating/rust, analyzer/nodejs]
refinement: not-started
---

# Message construction in `@telorun/cel`

## Problem

`@telorun/cel` is a standalone CEL library, and third parties use it as one (issue telorun/telo#851). cel-spec's aggregate syntax `Name{field: value}` builds a value of a named type. The engine cannot read it at all: `Place{street: 'Main'}` is a parse error, `unexpected_token` with `"{" cannot stand here`, whatever types the host has registered. 552 cel-spec tests use the form.

The engine already has most of what construction needs. A host's `registerType` can declare a named type with `fields`. Its values carry the type key and the fields as their own entries. `.`, `.?` and `has()` read those fields typed as declared, and an undeclared one is `CEL_UNKNOWN_FIELD`. What's missing is that only host code can create such a value, and two of them are equal only if they are the same object.

## Constraints

- the issue is about our CEL package only, so this should not be bound to telo json schema and should be solved generically

## Surface

**Added**
- `Name{field: value, …}`, `.Name{…}`: CEL syntax that constructs a value of a registered named type
- `?field: value`: an optional field entry in a construction, under `enableOptionalTypes`; an absent optional leaves the field unset
- `constructible` on `NominalTypeDefinition` (Node) and its Rust twin: the type opts in to construction
- `required` on `NominalTypeDefinition` (Node) and its Rust twin: the fields a construction must write
- `construct`: a builder passed with `registerType` that builds the value from the written fields, or answers a CEL error value
- `CEL_UNKNOWN_TYPE`: check code for a construction naming no registered type
- `CEL_TYPE_NOT_CONSTRUCTIBLE`: check code for a construction naming a language type, a well-known type or a type without the opt-in
- `CEL_MISSING_FIELD`: check code for a construction that omits a required field, or writes one as `?field:`
- `struct`: syntax tree node kind holding `typeName`, `absolute` and the field entries `{ field, value, optional }`
- `types`: a language-row key in `templating/cel-conformance/language.json` carrying the type definitions a row registers
- `telo/construction/<case>`: row ids of the authored construction rows

**Changed**
- equality: values of a constructible type compare field by field instead of by identity; a host-registered `==` still wins
- `EMITTER_FORMAT_GENERATION`: bumped from 2 to 3, invalidating every stored emitted module
- `templating/cel-conformance/README.md` drop rule: a cel-spec test is dropped because it names a message type defined by a protobuf descriptor, no longer because of its syntax

**Removed**
- None.

## Solution

Construction becomes an operation of the named type, declared in the data the host already registers. `registerType` takes two new definition keys and one new option:
- `constructible: true` opts the type in. The type must declare `fields` (an empty set is fine) and no `parameters`.
- `required` lists the field names a construction must write.
- `construct` is an optional builder. Without one, the engine builds the value itself, in the same form a host-built value has today. With one, the builder receives the written fields (unset ones left out) and answers a value or a CEL error value, as a registered implementation does. A host whose values carry an invariant can therefore make its type constructible without giving the invariant up.

**Parser and serializer.** Both read and write the new `struct` node. The leading dot of an absolute name is kept. Error recovery keeps the field entries already read. Every tree walker in the engine, the templating tag engines and the analyzer handles the new node.

**Checker.** A construction name is resolved only against the registered types, by its full dotted name; `.Name` means the same as `Name`.
- A name with no registered type is `CEL_UNKNOWN_TYPE`, even under `unlistedVariablesAreDyn`. The message lists the nearest constructible names, the way unknown-function candidates are listed.
- `int{}`, `google.protobuf.Timestamp{…}` and a registered type without the opt-in are `CEL_TYPE_NOT_CONSTRUCTIBLE`.
- Each field is checked:
  - one the type does not declare is `CEL_UNKNOWN_FIELD`;
  - one written twice is `CEL_INVALID_ARGUMENT`;
  - a value not assignable to the field's type is `CEL_TYPE_ERROR`;
  - an omitted required field is `CEL_MISSING_FIELD`.
- The result has the named type.

**Runtime.** The closure backend and the JS-source emitter build the value through the builder or the engine's default. The value is read like any host-built value:
- an unset field is `no_such_key` on an ordinary read and absence under `.?`, `[?]` and `has()`;
- the engine's one equality compares values of a constructible type by type key, set of present fields, and pairwise field equality, unless the host registered `==`, which wins;
- `!=`, `in` over a list, and list and map equality inherit it;
- the environment digest carries `constructible` and `required`.

**Rust twin.** `cel/rust` gets the same definition keys, the same builder, refusals, node, codes and equality. Both engines are held to authored rows `telo/construction/<case>` in `language.json`, which register their types through the new row key `types` (the definition data, in registration order, declared without implementations). The builder is pinned by twin unit tests in `tests/nominal-fields.test.ts` and `cel/rust/tests/nominal_fields.rs`, since a row cannot carry an implementation.

**Telo's own host** marks nothing constructible. In a manifest, `Telo.Url{scheme: 'https'}` is `CEL_TYPE_NOT_CONSTRUCTIBLE`, where today it is a syntax error. The value types under `sdk/value-types/` are unchanged, and no module moves its `requires:` floor.

**Docs and release.**
- `cel/nodejs/CLAUDE.md`: the named-types section, the "deliberately still refused" list and the check-code count.
- `cel/rust/README.md`.
- The conformance README: the `types` row key, and the reworded drop rule. A test constructing `google.protobuf.Timestamp` or `google.protobuf.Duration` in message syntax is kept, answering `CEL_TYPE_NOT_CONSTRUCTIBLE` with `deviation.reason: feature-not-carried`.
- One `Added` fragment on the `cel` unit.

## Decisions

- **Opt-in, not implied by `fields`**: a host type with an invariant (a URL a host validates) would otherwise be constructible around its validation forever.
- **An optional builder** is the type-provider `NewValue` that cel-go, cel-java and cel-cpp converge on, split as the engine already splits a signature (data) from its implementation.
- **An unset field reads as absent**, the same for a constructed value and a host-built one. Proto3 zero values were rejected: a `dyn`, union or named field has none. Per-field defaults were rejected: they need a value encoding in the type data, and `.?f.orValue(x)` already gives a default.
- **`required` is checked statically**, so a missing field the source plainly omits is reported at the literal rather than at runtime as `no_such_key`.
- **Field-wise equality only for constructible types**: being constructible is a promise that a value is its fields, while a non-constructible host value may hold state the engine cannot see.
- **Parameterized types are not constructible**: the syntax has no place for type arguments, and inferring them from the written fields guesses a type that both engines would have to guess identically.
- **No `container` option**: resolving type names against a container while every other name ignores it would give one expression two resolution rules.
- **`CEL_UNKNOWN_TYPE` is its own code** rather than `CEL_UNKNOWN_IDENTIFIER`, because a host that suppresses unknown identifiers must still refuse an unknown type: nothing can be constructed from `dyn`.
- **The cel-spec protobuf rows stay dropped**: hundreds of rows answering the same refusal would pin only that no protobuf provider is present. A protobuf provider is a separate package with its own descriptors and vectors, outside this plan.

## Complete example after the change

A host registers `Place` with fields `street: string`, `number: int`, `tags: map<string, string>`, `constructible: true` and `required: [street]`.
- `Place{street: 'Main', number: 4}` checks as `Place`. Evaluated, `.street` is `'Main'`, `has(.tags)` is `false`, and an ordinary `.tags` is `no_such_key`.
- `Place{street: 'Main'} == Place{street: 'Main'}` is `true`, and `[Place{street: 'Main'}] == [Place{street: 'Main', number: 1}]` is `false`.
- `.Place{street: 'Main'}` is the same construction and writes back with its dot.
- `Place{?number: optional.none(), street: 'x'}` leaves `number` unset.
- `Place{number: 1}` is `CEL_MISSING_FIELD`; `Place{street: 'x', floor: 2}` is `CEL_UNKNOWN_FIELD`; `Place{street: 'x', street: 'y'}` is `CEL_INVALID_ARGUMENT`; `Place{street: 1}` is `CEL_TYPE_ERROR`.
- `Shop{}` is `CEL_UNKNOWN_TYPE`, naming `Place` as a candidate, even under `unlistedVariablesAreDyn`.
- `int{}` is `CEL_TYPE_NOT_CONSTRUCTIBLE`.
- With a builder that refuses an empty street, `Place{street: ''}` evaluates to the builder's error value on both backends and in both engines.
