---
"@telorun/cel": minor
---

`@telorun/cel` evaluates: the semantics, the value domain and the eval-free closure backend.

**Every operator, conversion and standard function behaves as cel-spec requires**, and lives exactly
once (`runtime-library.ts`, keyed by the dispatch key the registry resolves on, with the declarations
staying data). `int` is a `bigint` and an overflow is an **error rather than a wrap**; `uint` and
`double` are distinct; division and modulus by zero are two different errors; bytes and strings are
distinct and both are ordered; an instant is nanosecond-precise and its getters take a zone — an IANA
name or a fixed `HH:MM` offset; `matches` is **RE2**, so a pattern the host's own engine would accept and
RE2 would not is refused rather than silently matched. `int(duration)` is there too, which no conformance
row pins.

A duration's `getMilliseconds()` answers the **component** (321 for `123.321456789s`), as a timestamp's
always has, rather than the total; `int()` refuses a double **at or beyond either** int64 extreme; and the
engine's **one comparison** converts across the numeric types the way cel-spec's does — the sign decides
where the double lies outside the integer's range, and otherwise two doubles are compared, lossily, so
`dyn(9223372036854775807) < 9223372036854775808.0` is `false`. A map's key identity is **not** that
comparison and does not convert.

**A duration is the signed 64-bit range of its total nanoseconds** —
`-9223372036.854775808s … 9223372036.854775807s`, roughly ±292 years — which is cel-spec's own limit,
stated under *Overflow* in its language definition and read by all six of the vectors'
`timestamps/duration_range` rows. It is checked at every point a duration is built: the conversion,
duration `+` and `-`, `timestamp - timestamp`, and the duration operand of `timestamp ± duration`. That
range is a **subrange** of `google.protobuf.Duration`'s ±10,000 years, which Telo's typed frame keeps
deliberately so that a duration arriving from a transport, a journal or a controller is always
representable — so `duration('200000000000s')` is a value the frame carries and CEL cannot construct.
Nothing about the frame, the plain encoding or the value-type entries changes.

**Eight string declarations are named as not CEL's**, taking the library's `"spec": false` count from 11
to 19: `indexOf`, `lastIndexOf` and `substring` in both arities, `lowerAscii` and `upperAscii`.
cel-spec's standard definitions over strings are exactly `size`, `startsWith`, `endsWith`, `matches`,
`contains` and concatenation; everything else is the strings extension's, which Telo does not ship. Each
reason names that authority, the extension that has the equivalent, and **where this member differs from
it**: the three index-taking members index by **UTF-16 code unit rather than code point** — a port
reading them as the extension's would index by rune and silently change the answer of every manifest
that cuts a string — and `lowerAscii` / `upperAscii`, despite their names, apply the host language's own
casing rather than touching the ASCII letters alone. `trim`, `split` and `join` keep their entries with
their own differences stated.

**A CEL error is a VALUE that participates in short-circuit.** `false && <missing key>` is `false` and
`true || <missing key>` is `true`, whichever side the error is on, so every operator, comprehension step
and conditional carries an error-valued operand through; an error that survives to the top of an
evaluation becomes a thrown `CelEvaluationError` carrying one of the closed `CEL_EVALUATION_CODES` and
the range of the text it is about. Thrown where it was found, the short-circuit rules would be
unimplementable.

**Evaluation is synchronous on both backends.** A registered implementation's return type is not
thenable, so an asynchronous one does not compile; a thenable that reaches evaluation anyway is
`async_value_unsupported` with a range, never a value passed along.

**A value says what it is by a string type key** under `Symbol.for("telo.cel.value")`, never by its
constructor: two copies of the engine agree about a value either of them built, and a key that cannot
appear in parsed JSON means an inbound body cannot forge a duration — a plain object carrying a
string-keyed look-alike brand is data, and reads as a map. What is plain carries no key (`null`, a
boolean, a string, a double, a `bigint` int, `Uint8Array` bytes, an array, a string-keyed plain object);
the closed `CEL_VALUE_KEYS` cover what has no faithful plain form — a uint, a timestamp, a duration, a
type value, an optional, a map with typed keys, and an error. A host's named type declares its own key
and a collision is refused at registration.

**The type a check REPORTS substitutes `dyn` for an unresolved type parameter**, which is the last step of
the rule the checker already applied to every use of one: `[]` is `list` and `optional.none()` is
`optional<dyn>`, while a parameter survives where it is declared — a signature's text, a nominal type's
parameter list. And **a dotted chain splits once**, over the names the host declared, through one function
the checker and the backend share: a declared chain is split at compile time, so evaluating it is one
activation read rather than a search, and a declared name the activation does not hold fails for that name
instead of quietly reading a shorter prefix.

**Every member read goes through one lookup** over the value's own entries — `a.b`, `a['b']`, `a[expr]`,
`.?`, `[?]`, a macro's field read and `has()` alike — so no key, however it was computed, reaches a
prototype, a method or a function property: `a['length']` on a map is a missing key and
`a[request.query.k]` cannot reach `constructor`. A missing key is the `no_such_key` error value, an index
into a list is bounds-checked, a select on something that holds no members is an error, and **a CEL map
is built prototype-free**, so `__proto__`, `constructor` and `prototype` round-trip as data.

**The closure backend uses no `eval`, no `new Function` and no disk**: a tree compiles into nested
closures over the runtime library, with everything an expression's shape decides settled at compile time.
Macros lower there and in the checker from one binding table — `has`, `all`, `exists`, `exists_one`, `map`
in both arities, `filter`, `cel.bind`, `optMap` and `optFlatMap` — and there is still no comprehension
node, so the tree stays writable back to source. Overloads are resolved on the values' own types per call
site, because `dyn` reaches the runtime and `dyn(1.0) == 1` must answer `true`. `qcall` dispatches through
a table the host binds per evaluation; one nothing binds is `unbound_function`. Every in-process cache is
bounded with a declared capacity, and **every registration forgets what the environment compiled**, so a
replaced function cannot be served from a cached program.

Two corrections to what the front end read. A **bytes literal holds the UTF-8 of its text** — `b'ÿ'` is
`0xC3 0xBF`, not `0xFF`, which is cel-spec's answer and the only reading under which `b'ÿ' ==
b'\303\277'` holds; and **namespace resolution answers without walking** where no namespace is
declared, which is every site that has none.

The conformance vectors are now replayed at the **value** level as well as the check level, with the
completeness invariant the check-level one cannot have: per row, the engine either answers what the row
records, or answers cel-spec — verified against the row's own `deviation.celSpec`, so a correction is
evidence rather than an exemption — or stands on the recording with a reason; a row on none of those
fails the gate — in **both** directions: a row cel-spec answered must be listed whichever way the engine
went, because a `matched` bucket that never consults `deviation.celSpec` counts following the recording as
agreement. 1,814 rows: 1,065 answered as recorded, 120 corrected against cel-spec, 625 excluded with a
reason, 4 answered by the check-level driver, 0 unaccounted —
and six of them, the rows whose recorded error text the format owns rather than the replaced engine,
reproduced **byte for byte**, caret included. The check-level `extension-library` exclusion is narrowed
to the rows whose call the engine does not resolve, so the `string_ext` sections whose members this
library declares are compared like any other row: 608 → 547 excluded, 1,043 → 1,097 checked to the
recorded type. A corrected row is held to the type its own `deviation.celSpec` records, and the
round-trip assertion is outside the correction suppression — a correction is about a verdict, not a
licence to stop serializing.

`CEL_NULLABLE_ACCESS` now matches today's **subjects** as well as today's three guards: a chain rooted at a
name the expression itself bound is not a subject, so `xs.map(e, e.code)` over a nullable element is not
reported — reporting it would newly reject a manifest that checks today. And every door a host value comes
through is checked for a thenable, the member read included (`resources.<name>.status.<field>` is that
shape), so a promise nested in a host value is `async_value_unsupported` rather than a value handed on.

Still nothing consumes it: `@marcbachmann/cel-js` serves the whole repository, and no manifest, consumer
or module changes. The package gains its first runtime dependency, `re2js`, pinned exactly as templating
pins it, because CEL's pattern language is RE2.
