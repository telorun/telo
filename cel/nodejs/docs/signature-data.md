# Signature data

Two libraries, as declarations rather than as code: CEL's own
(`src/signatures/standard-library.json`) and the function catalog beside it
(`src/signatures/function-catalog.json`, [below](#the-function-catalog)).

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

Validate both with `pnpm --filter @telorun/cel run check:signatures`.

## The standard library file

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

## The function catalog

`src/signatures/function-catalog.json` is the **dialect**: the functions a manifest may call beside
CEL's own library. It exists for the same reason the file above does — a second implementation must
inherit the same surface, and a library written as registration calls becomes a second library the day
a port is written — and it follows the same rules, with the differences a second library needs.

**Nothing in it is cel-spec's, and that is declared once.** `"spec": false` and its `reason` sit on
the FILE, not on each of the 67 entries: repeating "cel-spec does not define this" 67 times would say
nothing a reader of the file does not already know, and the validator refuses an entry that carries
either key. What the reason has to say is why the file exists at all, so a port inherits none of it as
CEL.

| Key | What it holds |
| --- | --- |
| `generation` | The format's generation, a positive integer. Bumped when a reader must change. |
| `description` | What the file is, for a human opening it. |
| `spec` | Written only as `false`: not one function here is defined by cel-spec. |
| `reason` | Why the file is beside the language's own, once for all of it. |
| `categories` | The display labels a listing groups by. An entry's `category` must be one of them. |
| `functions` | One entry per function. |

An entry:

```json
{
  "name": "nowIso",
  "signature": "nowIso(string?): string",
  "signatures": ["nowIso(): string", "nowIso(string): string"],
  "category": "time",
  "summary": "Current time as ISO-8601; UTC by default, or in the given IANA timezone.",
  "deterministic": false,
  "hostBacked": false
}
```

- `name` — the bare name, which every one of its signatures must declare.
- `signature` — the signature a HUMAN reads, which is not always one registration: an optional
  parameter is written `fn(string?): string`, and an overload set with no single spelling is written
  with the widest one (`slice(dyn, int, int): dyn`).
- `signatures` — every signature the function **registers**, in registration order. The dispatch key
  is the name, the call form and the parameter types, as everywhere; two entries answering the same
  call, or one answering the same call as the standard library's — which registering it would silently
  **replace** — are refused by the validator.
- `category`, `summary` — what a listing prints. They are the whole of what `telo cel functions` reads
  beyond the flags, so the data carries them rather than a consumer re-deriving them.
- `deterministic` — `false` where two calls with the same arguments may answer differently (the clock
  and the UUID families).
- `hostBacked` — `true` for the nine functions the host implements, each needing a facility this
  package may not reach: `sha256`, `md5`, `sha1`, `sha512`, `hmac`, `base64Encode`, `base64Decode`,
  `json` and `joinPath`. A registration made with no handler still type-checks, and evaluating one
  answers `unbound_function` **naming the function**.
- `checksLiteralArguments` — `true` where the function refuses an argument written as a literal at
  CHECK (`CEL_INVALID_ARGUMENT`), which is the only way a refusal over a VALUE — an unparseable format
  specifier, a decimal count out of range, an unknown time zone, a pattern RE2 refuses — is reported
  without running the expression. The guard is the registration's (`LiteralArgumentCheck`), asked by
  the checker where the call resolves, and it runs the very code the evaluation runs.

What each function DOES is `src/catalog-runtime.ts`, keyed by the same dispatch key, and the two are
held to each other in both directions (`tests/function-catalog.test.ts`). The behaviour itself is
pinned by the conformance vectors' `catalog.json`, replayed in place: every overload, every refusal
verbatim in the catalog's own voice, and every host handler's call.

**Three conversions are deliberately NOT here.** `string(timestamp)`, `string(duration)` and
`int(timestamp)` are cel-spec's own and the standard library declares all three. A host registering one
of them again would replace the language's under the same dispatch key — silently, since replacing is
how registration works — so the catalog declares none of them, and the validator fails if it ever does.

