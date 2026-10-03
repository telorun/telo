# CEL (Node) — package guide

Loaded when working under `cel/nodejs/`. Repo-wide rules live in the root `CLAUDE.md`. This package is
`@telorun/cel`, on the telo version line, and it is **the CEL language and nothing above it**.

## The one boundary

**No host vocabulary lives here.** No kind, no annotation, no value brand, no manifest word. The engine
owns CEL — its grammar, its tree, its type system, its evaluation — and a host registers its own types
onto it from outside. The rule is checkable by grep: no file under `cel/nodejs` holds a host
schema-annotation key, nor a host type prefix. That is what keeps this package portable to another
runtime and auditable as "it implements CEL".

**The function catalog is the one thing that LOOKS like an exception and is not.** Telo's own 67
functions ship here, as data and implementations (below), and every one of their signatures is written
over CEL's own types alone — `string`, `int`, `list`, `map`, `bytes`,
`google.protobuf.Timestamp`. A value TYPE never appears in one: a port is typed as the host's own named
type by `registerType`, and `.joinPath` keeps a host path a host path because the host declares that
member on that type, not because this package knows what a path is. So the catalog is a set
of functions over the language's types, which is exactly what a dialect is — and if a change ever
seems to need a host type name in `src/`, that is the question to route rather than the line to bend.

**It depends on nothing in this repository.** Third-party pure-JS dependencies are allowed; a
workspace dependency is not, in either direction — the analyzer, templating, the SDK and the kernel
consume this package, never the reverse. **Three runtime dependencies, each pinned exactly**: `re2js`
(CEL's pattern language), `d3-format` (the number-formatting specifier grammar) and `uuid`. The pins
are exact because the conformance vectors pin those libraries' own answers — RE2's parse-error
vocabulary and its limits, d3's rounding, the UUID values — so an upgrade is a deliberate change that
re-runs the vectors.

**The entry reaches no Node built-in**, because the analyzer loads it in a browser. The gate is
`pnpm --filter @telorun/cel run check:browser-safe`: a real browser-platform bundle that follows
transitive dependencies under the `browser` condition and fails on any built-in, naming the file that
asked for it. A scan of import lines would miss a dependency's dependency.

## The front end

**The tree is canonical and ranged.** Every node carries `range`, the `[start, end)` span of UTF-16
code units it covers, because every consumer of a CEL expression ultimately points a human at text.
Literals are tagged (`{ type: "int", value: 1n }`) rather than bare JavaScript values: `1` and `1u`
are different expressions, and a backend must tell them apart without a runtime value class.

**`qcall` is produced by a pass, never by the parser.** `Alias.fn(x)` and `obj.method(x)` are the same
syntax; only a set of names that denote namespaces distinguishes them, and that set is the host's.
`resolveNamespaces` is therefore a **total** tree-to-tree pass taking the set, `parseExpression` always
runs it, and a `CelExpression` records the set it was resolved under — so a consumer can refuse a tree
resolved for a different site rather than silently answer the wrong question. `cel` and `optional` can
never be in a set: the standard macros are written on them, and a namespace would capture those calls.

**Macros stay ordinary call nodes.** Lowering `has(x)` or `xs.map(i, i)` to a comprehension at read
time would make the serializer unable to write the source back, which is the one property that lets a
tool hold a tree instead of text. Lowering belongs to the checker and the backends.

**Error recovery is a product feature, not a convenience.** Reading never throws and never discards
what it read: the first unreadable thing is one ranged diagnostic (`FirstSyntaxDiagnostic` holds the
first and drops the rest, so the lexer and the parser cannot disagree about where reading stopped),
and the tree keeps the longest prefix. A member with no name is a select with an **empty field name**
— the shape completion after a dot reads — and an open aggregate or call keeps the elements it read.
Neither serializes; the diagnostic is what says the tree is incomplete.

**The serializer refuses rather than guesses.** A tree with no source — an `unparsed` hole, a `NaN`
double, an integer outside its type, a name that is not a name — throws `CelSerializeError`, because
text that does not read back would make every later answer about it wrong. Parentheses come from
precedence; the source's own parentheses are not structure and are not remembered.

**A unary minus on a numeric literal folds into the literal.** It is the only way the int64 minimum is
written, and it keeps `-0.0` a value rather than a negation. The serializer therefore writes a
hand-built negation of a literal as `-(1)`, so a round-trip cannot change its shape.

**Limits are diagnostics.** Hostile input is in scope, and the five limits are reported like any other
unreadable input so an editor keeps its prefix.

## The grammar is cel-spec's, including the corners

Two readings the vectors pin, each recorded with no cel-spec answer against it:

1. **A reserved word is a legal member name** (`{'let': 1}.let`, `a.while()`, and so `a.in` and `a.true`
   too); it is refused only where an identifier is read.
2. **`rb'…'` is not a literal.** cel-spec nests the two markers — `BYTES_LIT: [bB] STRING_LIT` over
   `STRING_LIT: [rR]? …` — so the bytes marker comes first: `br`, `bR`, `Br` and `BR` are raw bytes, and
   `rb` is the name `rb` beside a string, which no expression admits.

And one the recording answers and cel-spec contradicts, so the engine answers cel-spec:

- **A bytes literal holds the UTF-8 of its text.** `b'ÿ'` is `0xC3 0xBF`, not `0xFF`: cel-spec's
  `BYTES_LIT` is a string literal under a bytes marker, and the recording's per-character reading made
  `b'ÿ' == b'\303\277'` false. An escape (`\xff`, `\303`) is still the one byte it names, and the
  serializer writes every byte as `\xNN` or as itself, so a round trip cannot change it.

Four the recording refuses and cel-spec answers, so the engine answers cel-spec:

- **A member name between backticks** — cel-spec's `ESCAPED_IDENTIFIER`, and **only where a member is
  read**: a backtick anywhere else is a syntax error, and a quoted name never names a called function
  (`member '.' escapeIdent` is a field), which is also what keeps a namespaced call to one spelling. It
  reads the key literally and is typed against a schema's `properties` exactly as a plain member is. Telo's
  own ground decides this one as much as cel-spec does: an index into a schema with `properties` is left
  unjudged, so `content-type` and every dashed or dotted key in a header map, a JSON payload or a column
  set would be unreachable by the type checker — a hole exactly where Telo's HTTP and SQL surfaces live,
  in the engine whose reason for existing is deep typing.
- **`[?x]` and `{?k: v}`**, under `enableOptionalTypes`: the entry holds an `optional<T>` and contributes
  a `T`, so an absent one leaves no entry behind. The syntax is gated with the library because a syntax
  for a type that does not exist would parse to a tree nothing can check — one switch, not two.
- **A double may begin with its point**: `FLOAT_LIT` is `DIGIT* . DIGIT+ EXPONENT?`, so `.99` is one
  literal.
- **An absolute name** (`.y`, `.y.z`): resolved against the environment's declarations and **never**
  against a name the expression bound. What the dot defeats in every row that exercises it is a
  comprehension binding — which Telo has everywhere, and without the dot an author whose comprehension
  variable is named like an outer one has no spelling at all for the outer one. `unlistedVariablesAreDyn`
  applies to it as to a bare name, and `.Alias.fn(x)` is a read of an undeclared name rather than a
  namespaced call.

**A dotted declaration is one name, and the longest prefix wins.** A host may declare `a.b.c`, or `a.b`
holding a map, or both; `a.b.c` then reads the variable of that name where it is declared and the map's
entry where only `a.b` is, so the host's own naming decides rather than the shape of the expression. A
name the expression bound takes precedence, exactly as for a bare name — unless the chain is absolute.

**Deliberately still refused**, and these are not oversights: `rb'…'`; a backtick outside a member read;
a quoted or absolute name as a namespaced call; and container-dependent resolution of a **bare** name,
which would mean inventing a container Telo never declares.

**Two cel-go libraries ship and the rest do not.** The **optional** library enters whole under
`enableOptionalTypes`, and `cel.bind` — cel-go's *bindings* extension — is always here, because a name
for one value is how an expression stops repeating itself and its eight rows are compared like any other.
Every other extension library (`strings`, `math`, `lists`, `encoders`, `sets`, `blocks`, …) is absent: a
call into one is an unknown function. The string members this library declares beyond CEL's own are not
that library — they are its own compatibility members, each saying so in its declaration.

## The reserved set is cel-spec's `RESERVED` — all 21 words, and no others

`IDENT` excludes `RESERVED`, so **no name position reads any of the 21**, and three of them are refused
by being read as something else: `true`, `false` and `null` are literals, `in` is the membership
operator. Accepting one as a name would be a spec violation and would falsify the premise every
consumer of the set is written against — static analysis refuses all 21 as a declared name on exactly
the grounds that CEL cannot read one. The split between "refused" and "read as something else" is the
lexer's whole policy about words, so it is declared once in `src/reserved-words.ts` (`wordReading`) and
the lexer holds no list of its own. A bare `in` where an expression must begin is an ordinary ranged
syntax error, as a misplaced operator is.

The member-name position is untouched by all of this: `a.in` and `a.true` read for the same reason
`a.while` does.

## A host's properties are kept out at the member-read seam — never by a word list

**The reserved set is CEL's own words and nothing else**, and `__proto__`, `prototype` and
`constructor` are legal everywhere a name may stand. A word list is the wrong instrument: a member
*name* is written by the author, while a member *key* can come from a request (`a[request.query.k]`),
so no list at any position touches the form an attacker can actually reach. It would also create a
disagreement the engine owns — a resource or variable may legally be named `__proto__` today, so
refusing it here would make a name static analysis accepts unreadable through CEL.

So the guarantee is **one member-read operation**, and these are its requirements, binding on the
checker and on both backends:

- One operation serves every form — `a.b`, `a['b']`, `a[expr]`, `.?`, `[?]`, and a macro's field read —
  resolving through a single lookup over the value's **own** entries. Neither backend ever performs a
  host property read, so no key reaches a prototype, a method or a function property.
- A key the value does not hold is the `no_such_key` error **value**, which participates in
  short-circuit. Never `undefined` passed along.
- A CEL map is built **prototype-free**, so every key — those three included — round-trips as data.
  Dropping a key is swallowing, and is forbidden.
- A select on a value that is not a map, a record or a registered type is a type error at check and a
  CEL error at runtime — never a lookup that happens to find `length`, `name`, `call` or `apply`.
- An index on a list is a bounds-checked element read, not a property read.

## cel-spec is the specification; the vectors are evidence

**Where the conformance vectors and cel-spec disagree, cel-spec decides.** The vectors are a
*recording* of the engine being replaced — their README says the rows are "as the Node engine answers
it" — and the format already carries cel-spec's own answer under `deviation.celSpec` wherever the two
differ. So a row is evidence of what runs today, and a row's own `deviation.celSpec` is the authority
for what this engine answers.

**The bound on that authority:** `deviation.celSpec` binds where **cel-spec's language definition** fixes
the meaning, or where **a library Telo enables** does. Outside it the engine answers the recording, and
says why. A row whose `deviation.uncarried` holds `disable_check` says nothing about checking at all.

**Two lists, and a completeness invariant over them** (`conformance/language-replay.ts`):

- `SPEC_CORRECTION_GROUPS` — where the engine answers cel-spec, each group naming its cause and its
  authority (a `deviation.celSpec` field, or a cited grammar production).
- `SPEC_EXCLUSION_GROUPS` — where it answers the recording, each carrying one reason from a closed set
  (`extension-library`, `feature-not-carried`, `container-not-declared`, `uncarried-input`,
  `evaluation-answer`) and a **pinned row count**, so a section that grows or shrinks fails the gate.
  **The set stays at five, and here is the guard that keeps it there:** every one of those reasons is a
  fact about the row's **input** — a library this engine does not ship, a cel-spec feature it does not
  carry, a container Telo never declares, a declaration the format could not carry (`disable_check` among
  them: cel-spec's value for such a row is what an evaluation answers with the check turned off) — or
  about **which seam** answers it. A fact about the input still has to be TRUE of the row: `disable_check`
  excuses a row only where this engine actually refuses at check, since a row it checks clean is not
  answering a different question — matching on the fact alone counted nine rows cel-spec never
  contradicted as excluded, and hid one whose real cause was the container it also declares. A
  disagreement about what the engine itself computes, reports or prints is a **correction with a cited
  authority, or a defect**. If a proposed sixth reason would describe the
  engine's own answer, the answer is what to change.
- **The invariant: every row that needs a position has one.** A row needs one when cel-spec answers a
  value or a type and the recording fails — at its check **or at its evaluation**. That second half is the
  whole point: the five dotted-declaration rows check clean in the recording and fail only when run, so a
  sweep that looked at refusals alone walked straight past them, and an opt-in list let the gap hide as
  silent agreement. The gate now names any row neither list accounts for.

Reading a row for a defect without first looking at its `deviation` is how two false findings got into an
earlier report of this card: **a row with no deviation of the kind in question is a row cel-spec was not
asked about, or agrees with.**

Not one byte of the vectors changes in this loop: the recorded engine answers every consumer until the
cutover, so a corrected row cannot be green before the swap. At the cutover each listed row's `expect` is
rewritten from its own `deviation.celSpec`, mechanically.

## The registry: nothing is privileged

**The standard library registers through the surface a host uses**, so a signature can be replaced or
removed per environment. That is the capability the package exists for: the engine being replaced
refuses `duration(string): <a host's own type>` as an overlapping overload, with no unregister and no
option that omits the library, so its `duration` is unchangeable and a duration value type has nowhere
to go. Here the **dispatch key is the name, the call form and the parameter types** — not the return
type — so registering `duration(string): Money` *replaces* the library's, and the original is gone from
that environment's listing. `removeFunctionsNamed` empties a name, and a call to it is then
`CEL_UNKNOWN_FUNCTION`. A `clone()` inherits everything and diverges without touching its parent.

**The engine's option defaults are CEL's own, not a host's.** `unlistedVariablesAreDyn` and
`enableOptionalTypes` are off and `homogeneousAggregateLiterals` is off, which is cel-go's reading; a
host that types only part of what a site may read turns the first on, and the recommended set for a
manifest runtime is `unlistedVariablesAreDyn: true`, `homogeneousAggregateLiterals: false`,
`enableOptionalTypes: true`. The third-party engine's own defaults were strict aggregates and
undeclared-is-an-error; aligning the default with the spec rather than with either host is what keeps
"what does plain CEL say" answerable here.

**`google` is kept.** It is a constant holding the two well-known type names, and it is the only
spelling in which an expression can name the timestamp or duration *type value* — `type(x) ==
google.protobuf.Timestamp`, which two conformance rows read. Dropping it would make that unwritable
with no replacement.

**Signature data is the contract a port reads** (`src/signatures/standard-library.json`, documented in
`docs/signature-data.md`, validated by `pnpm --filter @telorun/cel run check:signatures`). A library
written as registration calls becomes a second library the day a port is written; written as data it is
one artifact both read.

**A declaration CEL itself does not define says so, and says why** — `"spec": false` with a required
`reason`, gated by the validator in both directions. **Nineteen** declarations carry it: the eighteen
compatibility members the engine being replaced had — `string.trim`, `split` and `lastIndexOf` and
`indexOf` and `substring` in both arities, `lowerAscii`, `upperAscii`, `list<string>.join` in both,
`bytes.string`/`hex`/`base64`/`json`/`at` — and ordering **across** the numeric types, which CEL's checker
is strict about. cel-spec's standard definitions over strings are exactly `size`, `startsWith`, `endsWith`,
`matches`, `contains` and concatenation; everything else a string answers here is the strings
**extension's** territory, which Telo does not ship.

**A reason names three things**, because two of them are what a port needs: cel-spec's standard
definitions as the authority, the extension that has the equivalent, and **where this member differs from
that equivalent**. No member of this library may claim an extension's semantics. The differences that
matter: the index-taking members (`indexOf`, `lastIndexOf`, `substring`) index by **UTF-16 code unit, not
code point**, so a port reading them as the extension's would index by rune and silently change the answer
of every manifest that cuts a string; and `lowerAscii` / `upperAscii`, despite their names, apply the host
language's own casing rather than touching the ASCII letters alone. Both are what the recording answers,
and the vectors hold the engine to the recording for them — cel-spec is silent about a member it does not
define.

## The function catalog: the dialect, registered as a host registers one

**Telo's 67 functions are data plus implementations, and nothing about them is privileged.**
`src/signatures/function-catalog.json` declares them (86 signatures, documented in
`docs/signature-data.md`), `src/catalog-runtime.ts` is what each one does, keyed by the same dispatch
key, and `registerFunctionCatalog(environment, { handlers })` registers them through the **public**
`CelEnvironment.registerFunction` — literally the surface a host uses, so the catalog can be left out,
replaced function by function, or removed by name, and no code path in the engine behaves differently
for it. A default environment has no catalog: a consumer that wants the dialect asks for it.

**Nothing in it is cel-spec's, declared once for the file** rather than 67 times. The counterpart of
that is the rule the validator enforces: a catalog signature answering the same call as a standard
one would **replace** it silently, so none may — and `string(timestamp)`, `string(duration)` and
`int(timestamp)`, which the catalog carried while the language did not declare them, are deliberately
gone. The language layer declares all three, with the same call form, arity and return type, so no
expression loses a call.

**Nine functions are the host's**, each needing a facility this package may not reach — a hash, a byte
buffer, the host's own path separator, a JSON writer: `sha256`, `md5`, `sha1`, `sha512`, `hmac`,
`base64Encode`, `base64Decode`, `json`, `joinPath`. They are supplied through `CelCatalogHandlers` at
registration, and one left out still REGISTERS (an analyzer never evaluates, and must still type-check
the call) while evaluating it answers `unbound_function` **naming the function**. Never a null, never
an empty string: a hash that answers nothing looks like a value and ends up in a cache key.

**A refusal is the catalog's own words, in one voice** — `<function>: <what is wrong>`, identical on
every engine, and the vectors record 52 of them verbatim. It is never a library's wording or the host
language's: the regex family ends an invalid pattern with one of RE2's own parse-error kinds from a
closed vocabulary (`RE2_PATTERN_ERROR_KINDS`) and nothing after it, and `parseJson` words its own
offset from `src/json-text-scan.ts` rather than quoting the host parser. A refusal is thrown as
`CatalogRefusal` by the guard that meets it and becomes a CEL **error value** at exactly one place, so
the short-circuit rules still hold; anything else thrown while an implementation runs is this engine
failing, not the argument, and propagates. A parse failure RE2 reports outside that closed vocabulary
is one of those defects.

**A literal-argument guard is the CHECKER's, not the implementation's.** A signature constrains types,
so a refusal over a VALUE — an unparseable specifier, a decimal count out of range, an unknown IANA
zone, a pattern RE2 refuses — would otherwise fire only when the expression runs, which puts a defect
the source states behind a run. A registration may carry a `checkArguments` guard
(`LiteralArgumentCheck`), asked where the checker resolves the call and reported as
`CEL_INVALID_ARGUMENT` naming the call as it was written; twelve catalog functions carry one, and each
guard runs **the very code the evaluation runs**, so the static and dynamic answers cannot drift. An
argument that is not a literal arrives as `undefined` and a guard skips it.

**Two of its families reach a host facility, by declaration.** The clock (`now`, `nowIso`, `today`,
`nowMillis`, `nowSeconds`) and the random source behind `uuidv1`/`v4`/`v6`/`v7` are what
`deterministic: false` MEANS, and both are present in a browser as in Node, so the browser-safety gate
is unaffected. The language itself still reaches neither.

**`telo cel functions` reads one surface** — `functionCatalog()`, which answers each function with its
display signature, its category, its summary, its two flags and whether it guards its literals. A
consumer never reconstructs a listing from registrations, and the data carries everything such a
listing needs.

## The type system

**JSON Schema is the checker's native input, read to full depth.** Nested objects become records of
records, `items` becomes the element type, `additionalProperties` the value type of a map, and a union
stays a **union** instead of collapsing to `dyn` — so a typo two levels into a schema-typed variable is
a ranged `CEL_UNKNOWN_FIELD`, where an engine typing an object as a flat field map can only shrug.
Conversion is memoized by node identity within a document and happens **once per registration**, which is
the property the cost bound rests on: checking does not get more expensive as a schema gets deeper, and a
shape referenced a hundred times converts once (`tests/checker-cost.test.ts`, on a fixture whose every
level is reached through a reference and merged out of two `allOf` halves).

**Nothing a schema says may fall through to `dyn` in silence**, and that is a stronger rule than "every
keyword is read". The conversion answers a type **plus a report of every node it could not judge**, each
by JSON Pointer (`UnjudgedSchemaNode`, reached through `environment.schemaReports()`), with one reason
from a closed set: `keyword-not-read`, `shape-not-read` (a tuple `items`, a `type` naming no JSON type),
`reference-unresolved`, `intersection-empty`, and `named-type-unregistered` — the host's resolver naming
a type nothing is registered under, which is the host disagreeing with itself and was the one silent
fall-through left after the rest: the structural reading still stands and the disagreement is reported
beside it. It **reports rather than refuses** because a node it cannot type is usually a third party's
data — a schema shipped inside something a host merely loaded — so
throwing at registration would turn someone else's schema into a crash, while typing it `dyn` quietly is
the hole itself. The consumer that knows where the schema was written is the one that can anchor a
diagnostic at that line.

Completeness rests on `TYPE_CONSTRAINING_KEYWORDS`, an **engine-owned closed list of the keywords that can
change what CEL type a node has**: one this reader does not read is reported, and a node carrying none of
them says nothing about its type and is `dyn` legitimately, unreported. A keyword that constrains a
**value** rather than its type is deliberately off the list — `required`, `contains`, `propertyNames`,
`format`, every bound — because none of them can move a type and reporting them would be noise a consumer
learns to ignore. `tests/schema-keyword-coverage.test.ts` holds the list and the reader to each other in
both directions, with its own blind spot written down beside it.

**References split at the document boundary.** The engine's input is a node **plus the document it belongs
to**, the document travelling with the node as the descent moves between documents.

- A **document-local** reference (`#/$defs/…`, `#/definitions/…`) is resolved by the engine, against the
  document in hand.
- A reference that **leaves** the document is answered by the one host resolver the engine already
  consults at every node, whose answer is a registered type name with arguments **or the document to read
  in place of this node**. Which document a reference outside this one resolves against, and how a
  relative reference is rebased, is the host's half: there is no copy of its registry or its rebasing rule
  here, and no second seam. A node reported beyond the conversion's own document carries
  `throughReference`, the pointer of the reference that led out of it, so a consumer anchors at a line it
  has.

**A reference re-entered on the descent is the one deliberate `dyn`** — a recursive schema — and it is
**declared** (`recursive`) rather than reported: the descent terminates and the outer reading is what the
consumer gets.

**`allOf` intersects, and so does everything else one node says about its own type.** Records merge
field-wise and a narrower scalar wins, so a reference beside a `properties` block, or two partial records,
compose; a field of each half is read and a third is `CEL_UNKNOWN_FIELD`. Two parts that cannot both hold
are `intersection-empty` rather than silently resolved one way. **`enum` and `const` with no `type` are
read from their values' JSON types**, which is what makes a constant beside a host-typed branch a `string`
rather than a `dyn` that collapses the whole union.

**A flat field map is still accepted** (`{ fields: { columns: "map" } }`). It is not a convenience: a
consumer replacing an older engine has to reproduce its verdicts exactly before it turns deep typing
on, and a converter that only ever goes deep would force every such consumer to become stricter on the
same day it changes engines.

**A named type is not its base.** `registerType` takes a name over a base with its own operators,
comparisons, conversions, members and **invariant** type parameters, and a value of the base does not
stand where the named type is wanted — which is exactly what a slot wanting one must refuse, and what
an engine typing by wrapper class cannot express. A type argument that differs is
`CEL_TYPE_ARGUMENT_MISMATCH`, not a widening. `Self` inside a definition names the type being defined.

**Two seams let a host's vocabulary in, and only two**: `registerType`, and the `resolveSchemaType`
resolver asked at every schema node **before** the structural rules, with the document the node belongs to.
No host type name appears in this package.

**An unresolved type parameter behaves as `dyn` wherever it is used** — cel-spec's own row for it is
named `unconstrained_type_var_as_dyn`. So `[].filter(n, n % 2 == 0)` checks, `([].map(x, x))[0].foo` is
`dyn`, and a member, an index or a comprehension range over one is answered rather than refused.

**And the type REPORTED for one is `dyn` too** (`withoutParameters`, applied where the checker hands its
answer out). That is the same rule's last step, not a spelling: a consumer reading `list<T>` would have
to know what `T` means to this engine, and the answer is that nothing resolved it. So `[]` is `list` and
`optional.none()` is `optional<dyn>`. A parameter survives only where it is **declared** — a signature's
text, a nominal type's parameter list — which is what a definition listing still prints.

## The checker

**It decides every verdict, with a range, and nothing reads a message.** The nine CEL codes plus the
three namespaced-call codes are each decided where the cause is known — an unknown name, a call written
in the other form, an argument type no overload takes — which is what lets the after-the-fact classifier
beside the engine being replaced disappear. **A fix is a whole-source replacement**, built by rewriting
the tree and writing it back out, so a repair always parses and never depends on an offset that
re-indenting would move.

**`CEL_NULLABLE_ACCESS` recognises exactly three guards: `?:`, `&&`, `||`** (`nullable-access.ts`).
Recognising a fourth would make a consumer newly accept an expression on the day it changes engines;
recognising fewer would make it newly reject one. A guard written as a function call is deliberately not
proof. A value whose declared type admits null may always be compared against `null`, or declaring it
nullable would make it untestable.

**Its SUBJECTS are the other half of that compatibility, and are easy to miss.** A chain rooted at a name
the expression itself bound — a comprehension variable, a `cel.bind` name — is not a subject at all, so
`xs.map(e, e.code)` over a nullable element is not reported. Matching the guard set and not the subject
set would reject a manifest that checks today, which is the one thing this verdict's rules exist to
prevent.

**A macro's shape is judged before any type** (`macro-shape.ts`), innermost first: a macro binds a name
and that name is not a value, so `xs.map(1, …)` is wrong about its own shape rather than about a type,
and the body's typing depends on the name the call failed to declare. `has()`'s shape is the same kind of
rule — its argument's last step must be a select — and that is **all** it requires: cel-spec asks about a
member of any expression, so `has({'a': 1}.a)` and `has(optional.of(m).c)` are questions it answers.

**The call listing comes from the checker's lowering, never from the tree** (`resolved-call.ts`). A
macro lowers to a comprehension and reaches no function, so it is not listed; the calls written inside
it are. A list read off a tree instead reports whichever macros the reader's parser happened to expand —
which is exactly what the conformance vectors' own `calls` records, and why it is not this engine's
answer.

**A tree resolved under one namespace set, checked against an environment carrying another, is refused**
(`CelEngineError`, `namespaces_mismatch`) rather than checked: its qualified calls are not the ones this
environment would have found, so every answer about it would be about a different expression.

**A namespaced call is judged only against what the host DECLARED, and a host may declare less.** Two
withholdings, each **structural rather than a flag** (`tests/namespace-declaration.test.ts`):

- **An open namespace** (`registerNamespace(name, declarations, { open: true })`) declares only part of what
  it reaches: a name it does not carry types `dyn`, is **listed as a call**, and is reported by nobody.
  Openness is per namespace, inherited by a `clone()`, withdrawn by re-registering closed, and **in the
  environment digest** — it decides whether an expression checks clean, so two environments differing only
  in it must not share an emitted module.
- **A declaration that withholds its parameter list** (`{ name, returns }` beside `{ signature }`) types the
  call's result and leaves its arity and argument types unjudged. The two forms are exclusive **by
  construction**: a shape that supplied parameters and asked for them to be ignored would carry a list
  nothing reads, which no reader can tell from a list that is simply wrong. Such a declaration is listed as
  `total(…): double`, never as a function of no arguments.

**Why the engine declines rather than answers:** a host's name resolution can rest on vocabulary this
package may not learn (an export gate, a capability, a re-export chain), and its signature grammar can be
richer than CEL's (an optional trailing parameter, a declared JSON Schema per parameter — strictly stronger
than CEL assignability). Judging such a call here leaves the host one move, suppressing the verdict, which
is exactly the after-the-fact classifier this engine exists to retire. **The blind spot is written beside
the tests:** they can show the verdict is withheld and cannot show the host reports it instead, so each
case also asserts the call is **listed** — a verdict withheld and not listed is a verdict lost, and that is
the failure they can see.

## The value domain: identity is a string key, never a constructor

**A value says what it is under `Symbol.for("telo.cel.value")`** (`cel-value.ts`), as a string. Two
copies of the engine loaded independently are two sets of classes, so a constructor check would make a
`uint` one copy built not a uint to the other — `+`, `type()` and every overload would refuse it — and a
symbol from the global registry is the same symbol in both. It also cannot appear in parsed JSON, so an
inbound request body cannot forge a duration, which a plain string-keyed brand would allow: such an
object is **data**, and reads as a map.

**What is plain carries no key**, because the host platform already has exactly one representation for
it: `null`, a boolean, a string, a double (`number`), an int (`bigint`), bytes (`Uint8Array`), a list (an
array) and a map whose keys are all strings (a plain object, which is how a host hands one over). **What
has no faithful plain form carries the key** — and `CEL_VALUE_KEYS` is the closed set: `uint` (a
`bigint` is already an int), `google.protobuf.Timestamp` and `google.protobuf.Duration` (both
nanosecond-precise, which no host date type holds — `string(timestamp('…999999999Z'))` is a row), `type`,
`optional`, `map` (a map with int, uint or bool keys) and `error`. A host's named type registers its own
key, refused at registration if it is one of those.

**A map's entries are keyed by the canonical text of each key**, never by a property name
(`cel-map-value.ts`): that is what lets one container hold CEL's four key types, makes `1` and `1u` one
key as CEL equality requires, and means no key a map holds can reach a prototype. A map is **built** with
an int, uint, bool or string key — a double is not a key type, even a whole one — and still **looks one
up** by any numeric type, because `{1u: 1.0}[?1.0]` reads the entry.

## The semantics live once, under both backends

`runtime-library.ts` is what every operator and standard function **does**, keyed by the same dispatch key
the registry resolves on; the declarations stay data. Both backends call through it, so there is one answer
per operation and no second copy to drift. `tests/runtime-library.test.ts` holds the two artifacts to each
other in both directions — a declaration with no behaviour type-checks and then fails at evaluation, which
is the failure class the engine exists to remove.

**And everything AROUND a call lives once too** (`backend-runtime.ts`): admitting a host value, reading a
member in every form, `has()`'s presence question, taking a bool operand, an aggregate's optional entry,
reading a name or a dotted chain, and the per-call-site overload dispatch with its bounded cache. None of
it is a tree walk and none of it is an operator, which is exactly why it cannot live in a backend — the
closure backend compiles a tree to closures and the emitter compiles the same tree to JavaScript, and both
call *these* functions, by reference. That is what makes "the two backends answer identically" a property
of the wiring rather than a hope the tests confirm: the only thing the two compile differently is how
control gets from one call to the next.

**An error is a VALUE that participates in short-circuit.** `false && <missing key>` is `false` and
`true || <missing key>` is `true`, whichever side the error is on, so every operator, comprehension step
and conditional carries an error-valued operand through and only the top of an evaluation turns a
surviving one into a throw (`cel-program.ts`, `CelEvaluationError` with the code and the range). Thrown
where it was found, the short-circuit rules would be unimplementable. The codes are closed
(`CEL_EVALUATION_CODES`) and each is decided where the cause is known, never derived from a message.

**A comprehension's meaning is a function of its range and its body** (`comprehension-runtime.ts`), so
both backends lower a macro to the same calls. Error handling follows `&&`: `all` is `false` as soon as one
element is, even if another errors.

**Equality is universal at runtime, ordering is not.** The checker refuses `1 == 1u` on purpose, but
`dyn(1) == 1u` reaches evaluation and cel-spec answers `true` there — so where no overload takes the pair
and the call is an equality, the dispatcher falls back to the universal equality (a host's own
registration still wins, having resolved first).

**There is ONE comparison, and across the numeric types it CONVERTS** (`value-equality.ts`). It serves
`<`, `<=`, `>`, `>=`, cross-numeric equality and `in` over a list; a list index reads the element its
index names through the same rule. Where the double lies outside the integer type's range the sign
decides; otherwise the integer becomes a double and two doubles are compared — **lossily**, so
`dyn(9223372036854775807) < 9223372036854775808.0` is `false`. That is cel-spec's rule, named and
commented in its own corpus, and `int(double)` refuses a double at or beyond **either** int64 extreme for
the same reason. An exact comparison would be defensible alone and indefensible as a cross-engine
contract: a second engine on a conformant library would answer the other way on a comparison that can
decide an authorization or a retry bound. **A map's key identity is not this comparison** and does not
convert: a map is keyed by the canonical text of its key, so `{1u: 1.0}[?1.0]` reads the entry and
`[?3.1]` names none.

**Nanosecond precision and the declared ranges are the domain's**, not a host type's. An instant is
seconds plus nanos in `0001-01-01T00:00:00Z … 9999-12-31T23:59:59.999999999Z`. **A duration is the signed
64-bit range of its total nanoseconds** — `-9223372036.854775808s … 9223372036.854775807s`, roughly ±292
years — which is cel-spec's own rule, stated under *Overflow* in its language definition, and which all
six `timestamps/duration_range` rows read. A computation that leaves either range is an error, never a
value outside it, and the range is checked at every point a duration is built: the conversion, duration
`+` and `-`, `timestamp - timestamp`, and the duration operand of `timestamp ± duration`.

**A duration's `getHours`, `getMinutes` and `getSeconds` answer the whole span; its `getMilliseconds`
answers the component** — 321 for `123.321456789s` — which is cel-spec's split and the only one under
which the engine does not contradict itself, a timestamp's `getMilliseconds` having always answered the
component.

**Two durations, one nesting, and it is deliberate.** ±315,576,000,000s (±10,000 years) is **protobuf's**
`google.protobuf.Duration` range — what Telo's typed frame carries, so that a duration arriving from a
transport, a journal or a controller is always representable — and CEL's duration is a **subrange** of it.
So `duration('200000000000s')` is a value the frame carries and CEL cannot construct; that is the answer,
not a cost. Nothing about the frame, the plain encoding or the value-type entries changes for this. The
range is an invariant, not a storage format: the representation is still seconds plus nanoseconds.

## The closure backend

**No `eval`, no `new Function`, no disk** (`closure-backend.ts`, asserted over the source in
`tests/closure-backend.test.ts`): a tree compiles into nested closures over a frame, and everything an
expression's shape decides — which name is a bound slot, which select is a dotted activation read, which
call is a macro — is decided once, at compile time. Macro lowering is here and in the checker, from the
one binding table (`comprehension-bindings.ts`); there is still no comprehension node, because the tree
must stay writable back to source.

**A dotted chain splits once, over the names the host declared** (`declared-chain.ts`, read by the
checker and by both backends). A declared chain is split at COMPILE time, so evaluating it is one
activation read plus member reads — no search over prefixes — and a declared name the activation does not
hold is `no_such_variable` for **that** name, never a quiet fall back to a shorter prefix holding
something else. **The ROOT counts as a declared prefix**, and leaving it out was exactly the disagreement
this one function exists to prevent: with the split starting at two segments, a chain whose root alone is
declared fell into the search, so an activation holding both `a` and the key `"a.b"` answered `99` at
evaluation where the check had typed the declared name. A chain **no** prefix of which is declared is
searched at evaluation, longest prefix first, which is what every row binding a dotted key relies on and
where the checker has no opinion either. The checker takes its ordinary select path for a root-only split,
because the nullable-access rule is a fact about the expression's shape rather than about which name it
reads — one answer to "which name", two readings of what follows it.

**Overloads are resolved on the values' own types, per call site** (`CallSite`, in
`backend-runtime.ts`, so both backends dispatch through one object). A statically resolved signature is
not enough, since `dyn` reaches the runtime. A site holds its last resolution and reaches it by comparing
the type names themselves — building a cache key per call is the allocation that costs most on the
hottest path — with a bounded cache behind it for a polymorphic site. A container's element type is read
as `dyn` rather than walked, so dispatch does not get more expensive as the data gets larger.

**A registration's implementation is the host's half.** The engine's own implementations are looked up by
dispatch key, so a registration carries one only where the host supplies it; a call that resolves to a
registration with neither is `unbound_function`.

**A value that must be awaited is refused at every door it comes through, and the doors are a NAMED
list** — one refusal (`asyncValueRefused`, `cel-value.ts`), so no door answers with a different code or
wording:

1. an **activation read**;
2. a **registered implementation's result**;
3. a **member read**, every form — `a.b`, `a['b']`, `a[expr]`, `.?`, `[?]` — checked where the read
   ANSWERS rather than where the value is later used. `resources.<name>.status.<field>` is the shape a
   host actually hands over;
4. an **element entering a comprehension body** — all six macros, in `comprehension-runtime.ts` so both
   backends inherit it rather than each remembering to;
5. the **value a name is bound to** (`cel.bind`), refused once at the binding rather than at every read
   of the name;
6. an **optional's held value** entering a body (`optMap`, `optFlatMap`), because a host may hand over
   the optional itself;
7. **list membership**, which reads every element without binding one.

Dispatch and the program's exit keep a check as the **backstop** — what catches a door nobody has
thought of yet — so the cost stays off the path every operator takes.

**The three failures this list is the answer to, and they were all different.** A guard at dispatch and the
exit alone left `[x.p]` and `{'k': x.p}` answering a container with the promise inside it, while `x.p`,
`x.p + 1` and `[x.p][0]` were refused: the test proved the door that was closed. Worse, `xs.all(e, true)`
over a host list holding a promise answered **`true`** — not a value passed along but a wrong answer,
decided about a value nothing touched. `.map(` appears in 241 distinct `!cel` bodies in this repo, so a
comprehension is the common shape rather than an edge. Third, the refusal was then carried as an ordinary
error and so could be **discarded** by a readable element, which is the same wrong answer one layer in.
The forms are DATA (`BINDING_FORMS`), and `tests/evaluate.test.ts` holds that list to a probe per form,
under a constant predicate and a reference comparison both.

**The refusal is TERMINAL, and it is the one error in a comprehension that does not short-circuit.** It
is checked where the element is **bound**, before the body runs, and it ends the comprehension whatever a
later element would have decided. Carried as an ordinary error it was *discardable*, which made the answer
depend on which elements happened to be readable: `[P, 2].all(e, false)` answered `false` and
`[P, 2].exists(e, true)` answered `true`, each off the one element it could read. The distinction is what
the error is ABOUT — `no_such_key` is a fact about one datum, so a decided answer may legitimately outrank
it (`ms.exists(e, e.a == 1)` is still `true` over a list whose first entry has no `a`), while a value that
must be awaited says the host handed this engine something it cannot evaluate at all.

**Both predicates are probed, and neither alone is enough.** A constant predicate (`true`) exercises no
binding, and a reference comparison (`e == e`) exercises the binding without touching the value — so a
guard placed where the element is READ rather than where it is BOUND passes the first and can slip the
second.

**A container is NOT walked, and that is the boundary rather than a gap.** A thenable is refused where it
becomes a value the engine **reasons about**; walking would make every read cost the size of what it
returned. So `size(xs)` is `2`, `xs + [3]` copies the element along, a comprehension over a map binds its
string keys — and every way of getting the element back **out** is refused. The one place the boundary is
not where it should be: `celEqual` answers a `boolean` and cannot report, so `xs == [1]` is `false`
rather than a refusal; moving it would change that function's signature across the runtime library, both
backends and the map-identity path.

**Every registration forgets what the environment compiled.** A program holds the overloads its call
sites resolved to, so serving a cached one after the library changed would run the function that was
replaced — the precise failure the replaceable library exists to prevent.

**Every in-process cache is bounded with a declared capacity** (`bounded-cache.ts`): compiled expressions
per environment (`DEFAULT_COMPILED_CACHE_CAPACITY`), compiled patterns (`PATTERN_CACHE_CAPACITY`), a call
site's resolved overloads (`CALL_SITE_CACHE_CAPACITY`). Each is keyed on text an author's input decides,
so an unbounded one is a memory leak with that input as its key.

## The JS emitter, its key and its one store seam

The second backend compiles a tree to **JavaScript source** (`js-emitter.ts`), as one module for a set of
expressions (`emitted-module.ts`). It decides nothing the closure backend decides differently: what it
produces is a tree of calls into `backend-runtime.ts`, `runtime-library.ts` and `comprehension-runtime.ts`,
in the same order and with the same short-circuit.

**The runtime is INJECTED, never imported.** The module's default export is a factory taking the runtime
support library and answering one synchronous function per expression — a `CelStep`, which
`programOfStep` wraps so the top of an evaluation (the thenable backstop, a surviving error becoming a
throw) is the same code either way. The text names **no specifier of any kind**: a module importing
`@telorun/cel` would be loadable only where that specifier resolves, which excludes a `data:` URL, a
cache directory mounted elsewhere and a Rust host — and, worse, it would accept a version-skewed runtime
the key cannot see. `RUNTIME_BINDINGS` is the whole contract, one table the emitter destructures from and
`emitterRuntime` builds, so a binding one side has and the other does not cannot ship.

**The key covers the ENVIRONMENT, not just the source**: a hash over the emitter's format generation
(`EMITTER_FORMAT_GENERATION`), the engine version (`ENGINE_VERSION`), the environment digest, and the
canonical **ordered** list of expression sources — the order being part of the identity, because the
factory answers functions by position. The digest
(`environment-digest.ts`) is over the environment's **resolved listing**, never its registration history:
every function signature surviving registration and removal, every named type with its base and
parameters, every variable with its type, every namespace with its functions, every option value, sorted.
Keying on the history would fragment the cache into one entry per way of arriving at the same
environment.

**Why the key is that wide here.** Overloads are resolved at evaluation on the values' own types, so a
replaced library does not change the emitted *text* the way it would in an engine that baked a resolution
into the output. What it changes is the runtime object the module is handed — and the header repeats the
digest, so a module can only ever run against the environment it was written for. The wide key is what
makes the header a proof rather than a hope, and **over-keying is the safe direction**: a key too wide
costs a recompile, a key too narrow runs the wrong code.

**The integrity header carries FIVE fields, and the reason is that the provenance three answer only part
of the question.** The measurement that settles it: two different modules of one engine against one
environment emit **byte-identical** `format`, `engine` and `environment`. So those three catch a cache
root shared by two engines and a stale environment, and **nothing else** — not a half-written file, not a
hand-edited one, not a store that answered the wrong lookup. (An earlier version of this section credited
them with all three; that was false, and it is recorded here because the claim was repeated before it was
tested.)

- `key` — the module's own **identity**, the key this text was written for. It adds no concept: the design
  already had the name. It is in the header line **and** in the `integrity` export, so the load path
  refuses a mismapped module even when the host imported bytes the engine never hashed.
- `body` — the digest of the text **following the header line**. It covers every byte that is or could be
  read as code, the `integrity` export included, and leaves only the two banner lines uncovered. It is the
  decisive one, and the module's own banner argues for it: *edit the expression, not this* is evidence that
  someone will edit one, and a text with an intact header, an exported factory and a matching function
  count **runs**, whatever its body says. That is the one failure here that no retry undoes.

**`body` cannot live in the export it covers** — a digest has no fixed point inside the bytes it digests —
so it is carried only in the header line and verified only where the bytes are in hand. That is also the
split between the two paths:

- **The store-read path** (`emittedModuleRefusal`, reached through `environment.emittedModule`) has the
  text, checks all five, and every mismatch is a **recompile that names itself** in `refused`: *the stored
  module declares key `<x>` and the module asked for is `<y>`*, *the stored module's body does not match
  the digest its header declares*. Never a refusal the caller has to handle, never a run.
- **The load path** (`programsFromEmittedModule`) has an object and not the bytes, so it checks the four
  the export carries and throws `emitted_module_rejected` — now on a `key` mismatch as well. The function
  count stays as the cheap backstop; `key` is what actually tells two modules of one engine apart, which
  a count can only do by luck.

**The store's atomic write stays documented and no longer carries the guarantee.** Writing elsewhere and
renaming is still how a half-written entry is *avoided*, and avoiding one is better than detecting one.
But the guarantee rested on a promise this engine cannot check, made by a host it does not know; now the
`body` digest **detects** a truncated or edited text, so a host that gets the write wrong costs a
recompile.

Measured on the largest module the identity gate emits — 1,771 expressions, 838 KB — over five runs: the
body digest is **7-11 ms** and a whole store hit **9-15 ms** (the hit parses nothing, the trees being read
through a thunk only where there is something to emit), against **29-39 ms** to emit the module. So
verifying costs about a third of what it saves, once per module, and the hit path is digest-dominated
rather than parse-dominated.

**One store seam, and no loader.** The engine reads and writes module text by key through an interface the
host supplies (`EmittedModuleStore`) and **touches no filesystem**. It exports no loader, because a loader
would have to reach a filesystem (which this package may not), be `eval` (which the closure backend exists
to avoid), or be a `data:` URL import (fine under Node, refused under a browser's content security
policy). Nothing under `cel/nodejs` names a path outside it, the cache root included: a host anchors that.

**No bare property access implements a CEL read**, and the gate for it is over the whole emitted text
rather than over the names of a probe: every property the emitted code reads must be one of six
structural fields (`activation`, `namespaceFunction`, `present`, `held`, `push`, `call`), so a CEL field
name can never be among them however it was computed — which is the form (`a[request.query.k]`) no word
list could have protected.

**The digest is recomputed per emission, deliberately** (~430 µs against the standard library's 214
signatures, once per module rather than per evaluation). Caching it would have to be invalidated by every
registration, and a cache whose invalidation is threaded through eight mutators is exactly where a
stale-answer defect lives in a package whose reason for existing is that an environment can change.

**`EMITTER_FORMAT_GENERATION` is bumped on ANY change to the text the emitter writes for any tree** — not
only when the module's shape changes. The narrower rule asks whoever makes the change to decide that a
text difference is semantically neutral, and that judgement is exactly what produces the unrecoverable
failure: this emitter's own first defect moved no signature, no code path and no library entry, and a
module cached before the fix would have gone on answering `[2, 4, 6]` for `[3, 4, 5]` forever.
`tests/emitter-text.test.ts` is what makes the rule checkable — it pins the digest of the code the emitter
wrote for a corpus drawn from the package's own total enumerations (every `CelNode["kind"]`, every
`BINDING_FORMS` entry, every call in the registry listing, plus one hand-written group for the branches no
enumeration names), beside the generation, so a change to that text fails naming the bump it owes.
**Verified by negative control**: reintroducing the per-function numbering fails it with that message.
Its blind spot is written beside it and is low: the digest and the generation sit in one file and can be
re-recorded in one edit, so what it converts is a silent wrong-code-served into a fixture diff a reviewer
must approve. The pin is over the **factory** and not the whole text, because the envelope carries the
engine version and the environment digest and would re-record on every release.

**`ENGINE_VERSION` is GENERATED, never hand-written** (`scripts/generate-telo-version.mjs` writes
`src/engine-version.ts` at `prepare`, gitignored and required to stay untracked, exactly as it writes the
analyzer's surface generation and the language-server's engine identity). Its value is the telo line's
surface generation with `+unreleased` while a line changeset is pending. A hand-written constant held to
`package.json` by a test was the first shape and was wrong twice over: `package.json` holds the **last
published** version while a build implements the **next** generation, so under a pending bump the
assertion is false rather than merely weak — and the sentence claiming a test held it named a file that
did not exist. A content digest over the engine's own declared surface was the other candidate and is
blind in exactly the direction this field exists to look: that same temporaries defect leaves such a
digest byte-identical, and a Rust engine sharing a cache root would have to reproduce it byte for byte,
where the line's version is a number both halves already carry.

## `matches` is RE2

CEL's pattern language is RE2 (`regular-expression.ts`, over `re2js` pinned exactly, as templating pins
it): linear-time matching, no backreferences, no lookaround. The host's own engine accepts patterns RE2
refuses and is exponential on some of them, so an expression that matched here would behave differently
on another runtime and a hostile pattern in a manifest would be a denial of service. A pattern RE2 cannot
parse is `invalid_regular_expression`, never a silent `false`. It is the package's **one runtime
dependency**, and it costs the browser bundle about 420 KB.

## The conformance replay

The vectors are the cross-engine contract, and this package drives the **language rows** of them —
and, since the catalog ships here, the **dialect rows** too (below):
`conformance/language-replay.ts` holds the driver, `language-replay.test.ts` runs it. Per row it asserts
that a row recorded as checking checks **to the recorded type, spelled as the row spells it**, that a row
recorded as refused is refused **at the offset the recorded message's caret points at**, and that
whatever reads writes back and re-reads to an equal tree.

It is **half the answer and says so**. Three kinds of entry are declared in its report: what it answers,
what is **answered elsewhere** (values, errors, bindings and deviations — all evaluation's, every one held
by the value-level replay beside it), and what is **not comparable** — a recorded diagnostic's code is
always null and its wording is the engine being replaced's, so a refusal is compared by its verdict and
its offset rather than by its text. It also declares the files it does not drive at all. A driver that
answers half a file without naming the half is how a gap survives to a later gate.

**Both lists are asserted exact** — a new disagreement fails rather than hides, one that goes away fails
too, and an exclusion group that gains or loses a row fails. An exclusion is about the **verdict** first:
the engine refuses an extension call because it registers no such function where the recording refused
for its own reason, so where the two positions differ the row is named in that group's `offsetDiffers`,
again exactly. **An exclusion pins no TYPE, so an excluded row that checks clean is held to the recorded
type as any other clean row is**, with a per-group `typeDiffers` working exactly as `offsetDiffers` does.
Without it that branch compared nothing at all: a fabricated row declaring `1 + 1` to check as `string`
passed the gate, and D1 made the case live — the three `type_parameters_in_type_type` rows now report
`dyn` where the recording records a type parameter. And it covers **only rows whose call the engine does
not resolve**: the `string_ext`
sections whose members this library declares are compared like any other row, so a disagreement there is a
defect in the member to fix rather than a new exclusion.

**The value-level replay is the other half** (`conformance/value-replay.ts`). Per row, exactly one of:
**matched** (the engine answers what the row records, written canonically so a difference of CEL type is a
difference of text, or an error where the row records one — **and cel-spec asked nothing of this row**),
**corrected** (the engine answers cel-spec, and the driver then holds its answer to the row's own
`deviation.celSpec` — a correction is evidence, not an exemption), **excluded** (the recording stands, with
one reason — four of the check level's five, `evaluation-answer` having no counterpart because the rows it
covers are value-level corrections — and a pinned count), or **answered by the check seam** (cel-spec's
answer is a type, and the other driver holds the row to cel-spec's own recorded type: the defer requires a
**correction** over there, never merely an exclusion, which pins no type and would make the two drivers
each assume the other asked). Anything else
is `unaccounted` and the gate fails naming it; a listed row that now agrees fails too. An error's code and
message are not compared: a recorded error's code is always `null` and its wording is the engine being
replaced's.

**Both invariants are SYMMETRIC, and neither was at first.** The rule is: a row cel-spec answered must be
on a list **whichever way the engine went**. `matched` means "the engine agrees with the recording", and a
row can sit there while cel-spec says something else entirely — the engine then follows the recording
silently, which is the one outcome these two lists exist to make impossible. The check-level invariant had
the same hole for a **type**: it asked whether the recording *fails*, so a row where both engines check
clean to different types was invisible to it. Both now trigger on the row's own `deviation.celSpec`, not
on the recording's failure.

**Six rows are held to their recorded error TEXT, byte for byte, caret included**
(`RECORDED_MESSAGE_ROWS`). A recorded error is normally the replaced engine speaking, but these six are the
exception the format names: they are divergence rows, whose `expect.error` is the only `expect` in any file
that is not that engine's — a fixed summary for the condition plus the usual highlight. So they are the one
place where comparing a message says something, and the engine reproduces all six.

**A row the engine answers its own way is pinned, not excused** (`VALUE_PENDING_DECISIONS`): an entry lists
the question in full and the engine's exact answer, so the gate holds such a row as tightly as a matched
one. **The list is empty**, and is meant to stay that way — it exists so that the next question of that
kind is written down and measured rather than absorbed into an exclusion.

**A fourth driver answers the dialect files** (`conformance/dialect-replay.ts`, with the positions each
file needs in `catalog-replay.ts` and `types-replay.ts`): `catalog.json`'s 178 rows and `types.json`'s
26, replayed in place, under the same completeness rule — every row answered, corrected with a cited
authority, or excluded with one of the same five reasons, which **do not grow**. Today each file has
exactly one correction and no exclusion: `catalog/string/timestamp`, which is character for character a
language row the value replay already corrects, and `types/optional/none`, where an unresolved type
parameter is reported as `dyn`.

Three things about it are worth keeping:

- **The host's vocabulary is a PARAMETER, never a name written here.** `types.json` declares variables of
  Telo's nominal value types, so the driver takes a list of `NominalTypeDefinition`s
  (`CEL_CONFORMANCE_HOST_TYPES`, supplied by `scripts/check-cel-conformance.mjs` exactly as the vectors'
  path is) and registers each through `registerType` — and it **fails naming any type a row declares that
  the list does not carry**, rather than letting an undeclared name read as whatever it would read as.
  That is what lets the gate be driven by the host's own rows while the package stays free of a host type
  name.
- **A row's two halves are independent, as the format says**: the static half checks against the row's
  declarations plus the nominal types, and the runtime half evaluates against its bindings with
  **neither**, because at runtime a value of a nominal type IS its base. Checking first, as a language row
  is driven, would make every row that records a refusal at check and a value at evaluation (`p + 1` over
  a port) answer an error and compare nothing.
- **What it compares, and what it declares it does not.** The verdict and, for a clean row, the recorded
  type; the value, written canonically; that a row recorded as failing fails — and, where the recorded
  message is one the CATALOG words (`<function>: …`, 52 rows) or the recorded diagnostic is a
  literal-argument refusal (28 rows), that text **byte for byte**, which is the vectors' own rule for a
  refusal that is Telo's words rather than an engine's. Everything else in a dialect row's `check` is the
  TAG engine's answer about a scalar — the call listing at a scalar's offsets, the regions, the refs, the
  volatility, a site's context schema — and is declared as answered elsewhere rather than quietly skipped.

**A third driver asks a different question: do the two BACKENDS agree?**
(`conformance/emitter-identity.ts`). The two drivers above ask whether the engine's answer is right; both
run the closure backend, so an emitter that disagreed on two hundred rows would leave every count in this
directory untouched. This one runs every row through both and compares the canonical text of the answer,
so a difference of CEL type or of error range is a difference of text. Rows are grouped by the
**environment's own digest** — which is what the key is over — and each group is emitted as one module
and loaded once, so the gate exercises a module of 1,800-odd expressions rather than 1,800 modules of
one, which is also how a host will use it. Its own accounting is total: compared, not read whole, or
refused at compile by both with the same message, and the three must add up to the file.

**And it is deliberately not the only identity gate, because its filter cannot reach a form no row
writes.** The vectors are cel-spec's corpus: no comprehension over a host map, no chain into declared
state, no host-supplied implementation, no three-argument `map` whose filter and transform differ.
Measured rather than assumed, and on a **real defect** rather than an injected one: the emitter first
numbered its temporaries per function, so a comprehension body's `let t0` shadowed the `t0` its caller
held a bound value in and `cel.bind(n, 2, xs.map(e, e + n))` answered `[2, 4, 6]` for `[3, 4, 5]`. This
driver reported **0 disagreements** over all 1,814 rows with that bug in place; the case list caught it on
the first run. (Swapping `map/3`'s transform and filter behaves the same way.) So the two gates are
complementary and neither is redundant: `tests/backend-identity.test.ts`'s completeness is over the
grammar's node kinds (a `Record` over `CelNode["kind"]`, so a new node kind fails to compile until a case
exists for it) plus every binding form the engine enumerates and every one of the **300** calls the
registry holds over the two libraries — 214 of CEL's own and 86 of the catalog's
(`tests/standard-library-identity.test.ts`, generated from each environment's listing rather than written
out; a volatile call is compared by the TYPE of its answer, since two calls made a moment apart would
differ for a reason that is not a disagreement).
Conversely this driver catches what that one cannot: a disagreement on a value only cel-spec's corpus
thinks to write.

**The vectors directory is a parameter with no default** (`CEL_CONFORMANCE_DIR`), and nothing under
`cel/nodejs` names a path outside `cel/nodejs`: this package's own suite must pass with no sibling
package's tree on disk, which is why the replay is a separate config (`test:conformance`) rather than
part of `test`. The repository gate that knows where the vectors live is
`node scripts/check-cel-conformance.mjs`.

## What to ask of a gate in this package

**Every mechanism below was sound in the direction it looked and blind in the direction it did not** — and
every one was found by a human reading the code or comparing two rows of an output, never by the gate that
was supposed to hold it:

1. a sweep over the rows the recording **refuses**, which could not see a row that parses and is answered
   wrongly;
2. a check-level invariant over rows where the recording **fails**, which could not see a row where both
   engines answer and the answers differ;
3. an `extension-library` exclusion declared by **whole file**, which hid 61 rows whose call the engine
   resolves perfectly well;
4. a value-level `matched` bucket meaning "agrees with the recording", which never consulted
   `deviation.celSpec` and so counted 14 rows as agreement while cel-spec said otherwise;
5. a **type check scoped to `src`** (`build` compiles `tsconfig.lib.json`), while `tests/` and
   `conformance/` were in no gate at all and held a real error — the gate for the whole package is
   `check:types`;
6. a thenable guard verified at `[x.p][0]` and not at `[x.p]`: reading the element back out reached the
   guard, so the test proved the door that was closed and said nothing about the one that was open;
   and then verified at every door **a reviewer named** rather than at every door that **exists** — the
   comprehension element was outside the first list and answered `true` about a promise, so the fix is a
   gate over the engine's own enumeration of binding forms rather than over a list of cases;
7. a probe that looked for the leaked **value** — whether the printed answer contained `Promise` — which
   by construction cannot see a wrong **answer** computed over one, the failure the guard exists to
   prevent. It reported zero leaks over output in which `xs.all(e, true)` refused and
   `xs.exists(e, true)` answered `true`;
8. **an asymmetry between two forms of one rule is a finding, not a curiosity.** Those two rows were
   printed side by side by that same probe, and the only reason the discardable refusal was caught is
   that someone compared them against each other. Where one form of a rule refuses and its sibling
   answers, one of the two is wrong until it is explained;
9. an exclusion branch that compared a verdict and an offset and **no type**, so a fabricated row
   declaring `1 + 1` to check as `string` passed;
10. an exclusion matched on a fact about a row's INPUT (`disable_check`) without asking whether the fact
    is true of the row — nine rows the engine checks clean were counted as excused.

Each was *true*. None was *complete*. So the question to ask of any gate added here is not "does it pass"
and not even "does it fail when I break something" — it is **"what class of row can this mechanism not
reach, and what covers that class?"** Name the filter it applies (a refusal, a failure, a file, a bucket),
then describe a row that passes the filter and is still wrong. If you cannot describe one, say how you
know. A gate whose blind spot is written down beside it is a gate; one whose blind spot is implied by its
filter is a result waiting to be re-derived by hand.

## Where to look

- Tokens, literal decoding, every escape form → `src/lexer.ts`
- The grammar, precedence, error recovery, the limits → `src/parser.ts`, `src/parse-limits.ts`
- Node shapes, ranges, traversal → `src/syntax-tree.ts`
- `qcall` and the namespace set → `src/namespace-resolution.ts`, `src/cel-expression.ts`
- Writing a tree back, and what cannot be written → `src/serializer.ts`
- What an expression reads, and which namespaced functions it calls → `src/root-references.ts`,
  `src/qualified-calls.ts`, with the binding forms in `src/comprehension-bindings.ts`
- Which words are refused where → `src/reserved-words.ts`
- A dotted declaration, an absolute name → `src/declared-chain.ts` (the one split, read by the checker
  and the backend), `qualifiedVariableType` in `src/checker.ts`
- Types, their spelling, assignability and unification → `src/cel-type.ts`, `src/type-expression.ts`
- A schema or a field map as a type → `src/json-schema-type.ts`
- A host's own named type → `src/nominal-type.ts`, and `registerType` in `src/environment.ts`
- Registration, override, removal and overload resolution → `src/function-registry.ts`, `src/signature.ts`
- A namespace, what it declares and what it withholds → `registerNamespace` in `src/environment.ts`
  (`NamespaceFunctionDeclaration`, `NamespaceOptions`), `qualifiedCallType` in `src/checker.ts`,
  `tests/namespace-declaration.test.ts`
- The library as data → `src/signatures/standard-library.json`, `src/standard-library.ts`,
  `docs/signature-data.md`
- The CATALOG as data, and what it registers → `src/signatures/function-catalog.json`,
  `src/function-catalog.ts` (`functionCatalog()` is the one listing surface), `docs/signature-data.md`
- What a catalog function DOES, its refusals and its host seam → `src/catalog-runtime.ts`, with the
  calendar in `src/zoned-calendar.ts`, the JSON offset in `src/json-text-scan.ts` and RE2's parse-error
  vocabulary in `src/regular-expression.ts`
- A refusal over a literal argument, at check → `LiteralArgumentCheck` in `src/signature.ts`,
  `checkLiteralArguments` in `src/checker.ts`, the guards in `src/catalog-runtime.ts`
- Every verdict and its range → `src/checker.ts`, `src/check-diagnostic.ts`, with the macro passes in
  `src/macro-shape.ts` and `src/macro-check.ts` and the guard rules in `src/nullable-access.ts`
- What each call resolved to → `src/resolved-call.ts`
- What a value IS, and how it says so → `src/cel-value.ts`, `src/cel-map-value.ts`
- One member read, every form → `src/member-read.ts`
- What an operator or a function DOES → `src/runtime-library.ts`, with `src/integer-arithmetic.ts`,
  `src/value-equality.ts`, `src/value-text.ts`, `src/timestamp-value.ts`, `src/duration-value.ts`,
  `src/regular-expression.ts`
- A macro's meaning, as a function of its body → `src/comprehension-runtime.ts`
- Which forms bind a value into a body → `src/comprehension-bindings.ts` (`BINDING_FORMS`)
- What a value that must be awaited becomes, wherever one enters → `asyncValueRefused` in `src/cel-value.ts`
- Tree to closures, and macro lowering → `src/closure-backend.ts`; tree to JavaScript source →
  `src/js-emitter.ts`; what both backends do at a site (a host value, a member read, a bool operand, a
  name, one call site's dispatch) → `src/backend-runtime.ts`; the program and the top-level throw →
  `src/cel-program.ts`; the activation's reads → `src/activation.ts`
- An emitted module, its key, its five-field integrity header and the store seam →
  `src/emitted-module.ts`, with the environment's digest in `src/environment-digest.ts`, the hash in
  `src/sha256.ts` and the build's own identity in `src/engine-version.ts` (**generated**, gitignored)
- Whether the two backends agree → `tests/backend-identity.test.ts` (the grammar),
  `tests/standard-library-identity.test.ts` (every registry call),
  `conformance/emitter-identity.ts` (every vector row), with the host that loads an emitted module in
  `tests/emitted-host.ts` and the one call-source generator both gates read in `tests/registry-calls.ts`
- Whether the emitter writes the text it wrote before → `tests/emitter-text.test.ts`, over
  `tests/emitter-text-corpus.ts`, pinned in `tests/__fixtures__/emitter-text.json`
- A bounded cache → `src/bounded-cache.ts`
- Whether the whole package type-checks — `src`, `tests` and `conformance` → `check:types`
- The conformance drivers → `conformance/language-replay.ts` (check), `conformance/value-replay.ts`
  (value), `conformance/dialect-replay.ts` (the catalog and a host's types, with the positions in
  `catalog-replay.ts` and `types-replay.ts`), with the row encoding in
  `conformance/conformance-value.ts`
