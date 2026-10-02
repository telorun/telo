# @telorun/cel

The Common Expression Language, as a library: read an expression, hold it as a tree, check it, run it,
write it back.

```ts
import { parseExpression, qualifiedCalls, rootReferences, serializeTree } from "@telorun/cel";

const expression = parseExpression("Billing.total(cart.items)", { namespaces: ["Billing"] });

expression.diagnostics; // [] — nothing it could not read
rootReferences(expression.root); // ["cart"] — what it reads from its environment
qualifiedCalls(expression.root); // one call: Billing.total, arity 1, with its range
serializeTree(expression.root); // "Billing.total(cart.items)"
```

## What it answers

- **The whole expression grammar**, into a tree whose every node carries the `[start, end]` span of
  source it covers: int64, `u`-suffixed uint64 and double literals; single-, double- and
  triple-quoted strings, raw strings, `b"…"` and `br"…"` bytes, with every escape CEL defines; `true`,
  `false`, `null`; list and map literals; the operator precedence table; member access and index access
  in both their plain and optional forms (`.`, `.?`, `[]`, `[?]`), a member name between backticks, and
  a name a dot opens (`.y`); global calls and receiver calls.
- **Qualified calls.** `Alias.fn(x)` and `obj.method(x)` are the same syntax, so the only thing that
  can tell them apart is a set of names that denote namespaces. Pass that set as `namespaces` and
  every call on one of those names becomes a `qcall` node. An expression records the set it was
  resolved under, so a consumer can tell whether it is looking at a tree resolved for its own site.
- **Error recovery.** Reading never throws. A malformed or half-typed expression gives back a tree
  for the longest prefix that read, plus one diagnostic with the range of what stopped it — a member
  with no name yet (`request.`) is a select with an empty field, which is what completion after a dot
  needs.
- **Round-trip.** `serializeTree` writes any tree back as source that reads as an equal expression
  (`treesEqual`), parentheses placed from precedence rather than remembered from the text.
- **Two questions about a tree**: `rootReferences` — the first name of every access chain, excluding
  what a comprehension or `cel.bind` binds and excluding a namespace; and `qualifiedCalls` — every
  call on a namespace, in source order.
- **Input limits.** 100000 nodes, 250 levels of nesting, 1000 list elements, 1000 map entries and 32
  call arguments, each reported as an ordinary diagnostic rather than an exception, so hostile input
  behaves like any other unreadable input. `DEFAULT_PARSE_LIMITS` are those numbers; pass `limits` to
  change them.

## Checking

```ts
import { CelEnvironment } from "@telorun/cel";

const environment = new CelEnvironment({ enableOptionalTypes: true })
  .registerVariable("request", { schema: requestSchema })   // typed to full depth
  .registerFunction("sha256(string): string", { hostBacked: true, throws: ["ERR_DIGEST_FAILED"] })
  .registerNamespace("Billing", ["total(int, int): int"]);

const result = environment.check("request.query.limti");
result.valid;        // false
result.diagnostics;  // [{ code: "CEL_UNKNOWN_FIELD", message: "…(declared: limit, tags)", range: [14, 19] }]
result.calls;        // which signature each call resolved to, with its metadata
environment.check("request.query.limit").typeName; // "int"
```

- **Registration is not privileged.** CEL's own library registers through the same `registerFunction`,
  and the dispatch key is a call's name, form and parameter types — not its return type. So
  `registerFunction("duration(string): Money")` **replaces** the library's `duration(string)`, and
  `removeFunctionsNamed("duration")` makes a call to it `CEL_UNKNOWN_FUNCTION`. `clone()` inherits
  everything and then diverges.
- **JSON Schema is the native input, to full depth** — nested objects, element types, unions kept as
  unions, `allOf` intersected, and a reference followed. A flat field map (`{ fields: { columns: "map" } }`)
  is still accepted, for a host that must type exactly as shallowly as something it is replacing.
- **Nothing a schema says falls through to `dyn` in silence.** A `#/$defs/…` reference is resolved against
  the document the node belongs to; one that leaves the document is answered by the host's own resolver,
  which returns a registered type name **or the document to read in place of that node**. A node the
  engine has no rule for is **reported** by JSON Pointer rather than typed `dyn` quietly —
  `environment.schemaReports()`, so the consumer that knows where the schema was written can anchor a
  diagnostic at that line. A reference re-entered on the descent is a recursive schema: the one deliberate
  `dyn`, declared as such.
- **A named type is not its base.** `registerType({ name: "Money", base: "int" })` gives a type its own
  operators, comparisons, conversions, members and invariant type parameters; a plain `int` is refused at
  a `Money` slot, and `Holder<string>` where `Holder<int>` is wanted is `CEL_TYPE_ARGUMENT_MISMATCH`.
- **Every verdict carries a range and is decided by the checker** — `CEL_SYNTAX_ERROR`,
  `CEL_TYPE_ERROR`, `CEL_UNKNOWN_IDENTIFIER`, `CEL_UNKNOWN_FIELD`, `CEL_UNKNOWN_FUNCTION`,
  `CEL_WRONG_CALL_FORM`, `CEL_TYPE_ARGUMENT_MISMATCH`, `CEL_NULLABLE_ACCESS`, `CEL_INVALID_ARGUMENT`, and
  `FUNCTION_UNRESOLVED` / `FUNCTION_ARITY_MISMATCH` / `FUNCTION_ARGUMENT_MISMATCH` for a namespaced call.
  A fix, where one is offered, is the whole corrected source.
- **Three guards clear a read of something that may be null** and no others: `?:`, `&&`, `||`.
- **The optional library enters whole** where `enableOptionalTypes` is on: `.?`, `[?]`, `[?x]`,
  `{?k: v}`, `optional.of`, `none`, `ofNonZeroValue`, `hasValue`, `value`, `or`, `orValue`, `optMap`,
  `optFlatMap`, equality over optionals, `type()` of one, and the type name `optional_type`.
- **A member whose name is not an identifier is read between backticks** —
  `request.headers.`` `content-type` ``, typed against the schema's `properties` exactly as a plain
  member is, so a typo in a dashed or dotted key is still `CEL_UNKNOWN_FIELD`. Only where a member is
  read: anywhere else a backtick is a syntax error.
- **A dotted declaration is one name.** Declare `a.b.c`, or `a.b`, or both: `a.b.c` reads the variable of
  that name where it is declared and the map's entry where only `a.b` is — the longest prefix wins.
- **`.y` resolves against the environment**, never against a name the expression bound: it is the only
  spelling for an outer name where a comprehension variable shares it.
- `convertsToString(type)` answers whether a value of that type can be rendered as text by the
  environment's own `string()`.

The standard library is data — `src/signatures/standard-library.json`, described in
[docs/signature-data.md](docs/signature-data.md). It is **CEL's** library: a declaration CEL itself does
not define carries `"spec": false` and a reason saying why it is here, where the equivalent lives and how
this member differs from it — and nineteen do.

## Evaluating

```ts
const program = environment.compile("request.query.limit != null ? int(request.query.limit) : 25");

program.evaluate({ request: { query: { limit: "50" } } }); // 50n
program.evaluate({ request: { query: {} } });              // 25n
```

- **Every operator and function behaves as cel-spec requires.** `int` is a `bigint` and an overflow is
  an error rather than a wrap; `uint` and `double` are distinct types; division and modulus by zero are
  two different errors; bytes and strings are distinct and both are ordered; a timestamp is
  nanosecond-precise and its getters take a zone (an IANA name or a fixed `HH:MM` offset); `matches` is
  RE2, so a pattern the host's own engine would accept and RE2 would not is refused.
- **A duration is the signed 64-bit range of its total nanoseconds** —
  `-9223372036.854775808s … 9223372036.854775807s`, roughly ±292 years, which is cel-spec's own limit.
  It is checked wherever a duration is built: the conversion, duration `+` and `-`, `timestamp -
  timestamp`, and the duration operand of `timestamp ± duration`. A host's own duration format may be
  wider — `google.protobuf.Duration` is ±10,000 years — and CEL's is a subrange of it, so a duration a
  transport can carry is not always one CEL can construct.
- **Eight string members are not CEL's**, and each says so in its own declaration (`"spec": false` with a
  reason): `indexOf`, `lastIndexOf` and `substring` index by **UTF-16 code unit** rather than by code
  point, `lowerAscii` and `upperAscii` apply the host language's casing rather than touching the ASCII
  letters alone, and `trim`, `split` and `join` differ from the strings extension's equivalents in the
  ways their reasons name. `size`, `startsWith`, `endsWith`, `contains`, `matches` and concatenation are
  CEL's own.
- **An error is a VALUE that participates in short-circuit.** `false && <missing key>` is `false` and
  `true || <missing key>` is `true`, from either side; an error that survives to the top of an
  evaluation becomes a thrown `CelEvaluationError` carrying one of the codes in `CEL_EVALUATION_CODES`
  (`no_such_key`, `numeric_overflow`, `division_by_zero`, `modulo_by_zero`, `index_out_of_range`,
  `invalid_regular_expression`, `invalid_conversion`, `optional_value_missing`,
  `async_value_unsupported`, …) and the range of the text it is about.
- **Evaluation is synchronous**, and a value that must be awaited is refused at **every door it comes
  through**: an activation read, a registered implementation's result, a member read in any form, an
  element entering a comprehension body, the value `cel.bind` binds, an optional's held value, and list
  membership. Each answers `async_value_unsupported`, never a value passed along and never an answer
  decided about a value nothing touched: the element is refused where it is **bound**, and that refusal is
  terminal — `xs.all(e, false)` and `xs.exists(e, true)` over a list holding a promise refuse rather than
  answering off the one element that is readable, while an ordinary `no_such_key` still short-circuits as
  before. A container is deliberately not walked, so `size(xs)` and `xs + [3]` carry it along and every
  way of reading the element out is refused.
- **A value says what it is by a string type key** under `Symbol.for("telo.cel.value")`, never by its
  constructor, so two copies of the engine agree about a value either of them built. `null`, a boolean,
  a string, a `number` (double), a `bigint` (int), a `Uint8Array` (bytes), an array (list) and a plain
  object (a string-keyed map) carry no key; a uint, a timestamp, a duration, a type value, an optional,
  a map with typed keys and an error do. A plain object carrying a string-keyed look-alike brand is
  data, as it must be.
- **Every member read goes through one lookup** over the value's own entries — `a.b`, `a['b']`,
  `a[expr]`, `.?`, `[?]` and a macro's field read alike — so no key, however it was computed, reaches a
  prototype, a method or a function property. A CEL map is built prototype-free, so `__proto__`,
  `constructor` and `prototype` round-trip as data.
- **No `eval`, no `new Function`, no disk.** A compiled expression is a tree of closures over the
  runtime library, which is where every operator lives exactly once. In-process caches — compiled
  expressions per environment, compiled patterns, a call site's resolved overloads — are bounded, each
  with a declared capacity.
- `evaluateToValue` answers the error value instead of throwing, for a caller that carries errors
  itself. A namespaced call is dispatched through `namespaceFunction`, supplied per evaluation; one
  nothing binds is `unbound_function`.

## What it deliberately does not do

- **Nothing is expanded at read time.** `has(x)`, `xs.map(i, i)` and `cel.bind(x, 1, x)` are ordinary
  call nodes in the tree; the checker lowers them, so the source stays writable from the tree.
- **It knows no host's vocabulary.** No type name, no function catalog, no manifest word: a host
  registers its own through `registerType` and one schema resolver.
- **It never type-checks on its way to evaluating.** The checker decides every verdict and a consumer
  asks for them; compiling refuses only what cannot be compiled at all — a source that did not read
  whole.
- **It reaches no host facility.** No filesystem, no clock, no network, no Node built-in — it runs
  unchanged in a browser.

## Reserved words

CEL reserves 21 words, and none of them can be read as a name: `as break const continue else false for
function if import in let loop namespace null package return true var void while`. Seventeen are refused
outright; `true`, `false` and `null` are literals where they stand, and `in` is the membership operator,
which is why a name position can never reach them.

A reserved word is still a legal **member** name — `{'let': 1}.let`, `a.while()`, `a.in`, `a.true` — which
is CEL's own rule: a member names an entry of a value, not a name in the expression's scope.

Nothing is reserved on a host's behalf: `__proto__`, `prototype` and `constructor` are ordinary names.
Keeping a host's own properties out of a CEL value is the member read's job, not a word list's — a
member key can be computed (`a[request.query.k]`), which no list of names would judge.

`cel` and `optional` are ordinary identifiers, but can never be registered as a namespace: the
standard macros are written on them.
