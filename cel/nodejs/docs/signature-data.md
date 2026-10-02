# Signature data

CEL's standard library, as declarations rather than as code: `src/signatures/standard-library.json`.

It exists because **a second implementation of this engine must inherit the same surface**. A library
written as one language's registration calls is a second library the moment a port is written, and the
two drift silently — a missing overload is a manifest that checks in one runtime and fails in another.
Written as data, the surface is one artifact both read, and the validator below holds it to its own
rules.

Nothing here is an implementation. A signature says what a call takes and answers; what it *does* lives
beside it, per runtime — in this one, `src/runtime-library.ts`, keyed by the same dispatch key the
registry resolves on. The two are held to each other in both directions (`tests/runtime-library.test.ts`):
a declaration with no behaviour would type-check and then fail at evaluation, and an implementation
nothing declares is unreachable.

Validate with `pnpm --filter @telorun/cel run check:signatures`.

## The file

One JSON object:

| Key | What it holds |
| --- | --- |
| `generation` | The format's generation, a positive integer. Bumped when a reader must change. |
| `description` | What the file is, for a human opening it. |
| `typeConstants` | Names that read as a type value (`int`, `list`, `null_type`, …), each of type `type`. |
| `constants` | Named values: `{ "name", "type", "description"? }`. |
| `functions` | The library's functions. |
| `optionalTypeConstants` | Type names registered only where optional types are enabled. |
| `optionalTypeOperators` | Operators registered only where optional types are enabled. |
| `optionalTypeFunctions` | Functions registered only where optional types are enabled. |
| `operators` | Operators over named types. |
| `symmetricOperators` | Operators declared over one type at a time, for both operands. |
| `crossNumericOperators` | Operators declared over two *different* numeric types. |

A key the loader does not read is a mistake, not an extension: the validator refuses one.

## A function entry

```json
{ "signature": "string.startsWith(string): bool" }
{ "signature": "string.trim(): string", "spec": false }
{ "signature": "bytes.json(): dyn", "deterministic": true, "description": "…" }
```

- `signature` — the whole declaration, in one grammar: `name(a, b): r` for a global call,
  `Receiver.name(a): r` for a call written on a value. A parameter type is a type expression:
  `int`, `list<string>`, `map<string, int>`, `optional<T>`, `google.protobuf.Timestamp`, or a single
  capital letter for a **type parameter** (the same letter means the same type within one signature).
- `spec` — written **only** as `false`, and only where CEL itself does not define the member. It is a
  declaration, not a note: a `reason` is required beside it and the validator refuses one without the
  other, in both directions. Absent means the signature is CEL's own. Without this gate the library grows
  a member nobody decided was outside the language, and a port inherits it as though it were CEL.
- `reason` — why a non-CEL member is here at all. Belongs only to a `"spec": false` declaration.
- `deterministic` — `false` where two calls with the same arguments may answer differently. Absent
  means deterministic.
- `description` — one sentence, where the name is not enough.

**The dispatch key is the name, the call form and the parameter types — not the return type.** Two
entries that answer the same call are a mistake (the second would be unreachable), and the validator
refuses them. It is also what makes a registration *replaceable*: a host registering
`duration(string): Money` replaces the library's `duration(string)`, because both answer the same call.

## Operator entries

An operator is not spelled as a signature, because its name is not an identifier:

```json
{ "operator": "+", "parameters": ["google.protobuf.Timestamp", "google.protobuf.Duration"], "returns": "google.protobuf.Timestamp" }
```

Two forms exist beside it, because the alternative is hundreds of near-identical entries:

```json
"symmetricOperators": [
  { "operators": ["==", "!="], "types": ["int", "uint", "…"], "returns": "bool" }
]
```
— each operator declared once per type, over two operands of that type; and

```json
"crossNumericOperators": { "operators": ["<", "<="], "pairs": [["int", "uint"]], "returns": "bool", "spec": false, "reason": "…" }
```
— each operator declared over two different numeric types. CEL's checker is **strict** about the numeric
types (its own conformance suite writes `dyn(1) < 2u` precisely because of that), so this block is
outside the language and carries `"spec": false` with its reason like any other non-CEL declaration.
Equality across the numeric types is **not** declared, and arithmetic across them never is.

`&&`, `||` and the conditional are not here: they short-circuit, so they are the checker's own and
cannot be overloaded.

## What the validator checks

- Every key, in the file and in each entry, is one a reader reads.
- A declaration CEL does not define carries `"spec": false` **and** a reason; neither appears without the
  other, and `spec` is never written as `true`.
- Every signature parses, and every type it names resolves.
- No two entries answer the same call.
- The whole file loads into an environment, and the environment registers at least as many functions
  as the file declares.
