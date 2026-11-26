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
what it read: the first unreadable thing **in source order** is one ranged diagnostic, and the tree
keeps the longest prefix. The lexer ends its token stream where the text it cannot read begins, the
parser reads every token before that, and the tree is therefore exactly the tree of the source cut
there — `1 + 2 + 'abc` is `(1 + 2) + <unparsed>`, not nothing. The lexer and the parser each hold
their first diagnostic (`FirstSyntaxDiagnostic`) and `firstInSourceOrder` picks one: the parser's when
it starts before the cut, otherwise the lexer's, so a tie goes to the lexer. `) + 'abc` reports the
parenthesis, since the source is already unreadable there. A member with no name — `a.`, and ``a.`` ``
with nothing between its backticks — is a select with an **empty field name**, `quoted: false`, the
one shape completion after a dot reads; an open aggregate or call keeps the elements it read. Neither
serializes; the diagnostic is what says the tree is incomplete.

**Every range lies within the source and splits no character.** A character outside the basic plane
is named whole and ranged over its two code units, where no token can stand and after a backslash
alike; an escape is ranged as it is **written** — the backslash, its marker and the run of digits of
its radix actually there — never by the width it should have had. A consumer that maps a range onto a
string slice in another language depends on it. The exception is a lone surrogate written raw, which
is not a character and is reported as the one unit it is.

**The serializer refuses rather than guesses.** A tree with no source — an `unparsed` hole, a `NaN`
double, an integer outside its type, a name that is not a name — throws `CelSerializeError`, because
text that does not read back would make every later answer about it wrong. Parentheses come from
precedence; the source's own parentheses are not structure and are not remembered.

**The round trip holds under the options the tree was read with, and has no exception.** Every source
that reads with no diagnostic writes, and its text reads back to an equal tree — with the optional
syntax on for a tree holding `[?x]` or `{?k: v}`, and under the same namespace set for a qualified
call. The writer takes no options: an optional entry is written wherever the tree holds one, because
such a tree exists only if a reader with the syntax on produced it or a host built it.

**A unary minus on a numeric literal folds into the literal.** It is the only way the int64 minimum is
written, and it keeps `-0.0` a value rather than a negation. The fold is on **tokens**, so whitespace
and comments between the minus and an int or double literal change nothing — `- 1` is the literal
`-1`, ranged from the minus — and a minus before a parenthesis never folds. A fold that depended on
spacing would make the int64 minimum's readability depend on formatting.

**So the writer parenthesizes the number the reader would fold.** Writing a unary minus, it finds what
the operand's text begins with — the operand itself, or what is reached by descending through the
operand of a member read, the operand of an index and the receiver of a method call — and when that is
an int or double literal that is not below zero and not negative zero, it writes that literal in
parentheses: `-(1)`, `-(1).a`, `-(1)[0]`, `-(1).f()`. A uint is never folded and gets none; a negative
literal is already parenthesized by precedence. The checker's fixes are written by rewriting the tree
and serializing it, so without this a fix touching such an expression would change its meaning.

**Limits are diagnostics.** Hostile input is in scope, and the five limits are reported like any other
unreadable input so an editor keeps its prefix.

**`maxDepth` bounds the height of the tree as well as the nesting of the grammar.** A node with no
child is 1 high, any other one more than its tallest child, and the reader refuses the node whose
height exceeds the limit — `limit_exceeded`, the same "more nesting" message, ranged over that node,
which it keeps, as it keeps the node past `maxNodes` (on one node the node count is judged first). The
grammar's own count is where it always was, zero-width at the token that would descend too far. So a
chain is nesting: `1+1+…` reads with 250 operands and is refused at 251, `a.b.b…` with 249 members and
at 250. The reason is every walker downstream — the checker, both backends, the emitter's output that
the host must parse, the tag engines, an editor — recurses over the tree, and a bound at the one
reader protects them all with a diagnostic pointing at the expression. **A tree read with no
diagnostic is at most `maxDepth` high; one read with a diagnostic is at most seven times that**, since
each open grammar level closes around the refused node with one bracket and five binary levels
(measured: 1750 under the default 250, pinned in `tests/parser.test.ts`). A tree taller than the stack
is reachable only by a hand-built tree or a host that raised `maxDepth`, as was always true of nesting.

## The grammar is cel-spec's, including the corners

Two readings the vectors pin, each recorded with no cel-spec answer against it:

1. **A reserved word is a legal member name** (`{'let': 1}.let`, `a.while()`, and so `a.in` and `a.true`
   too); it is refused only where an identifier is read.
2. **`rb'…'` is not a literal.** cel-spec nests the two markers — `BYTES_LIT: [bB] STRING_LIT` over
   `STRING_LIT: [rR]? …` — so the bytes marker comes first: `br`, `bR`, `Br` and `BR` are raw bytes, and
   `rb` is the name `rb` beside a string, which no expression admits.

And one the replaced engine answered and cel-spec contradicts, so the engine answers cel-spec:

- **A bytes literal holds the UTF-8 of its text.** `b'ÿ'` is `0xC3 0xBF`, not `0xFF`: cel-spec's
  `BYTES_LIT` is a string literal under a bytes marker, and the replaced engine's per-character reading made
  `b'ÿ' == b'\303\277'` false. An escape (`\xff`, `\303`) is still the one byte it names, and the
  serializer writes every byte as `\xNN` or as itself, so a round trip cannot change it.

Five the replaced engine refused and cel-spec answers, so the engine answers cel-spec:

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

- **Message construction** (`Name{field: value}`, `.Name{…}`, and `?field: value` under
  `enableOptionalTypes`): a `struct` node holding the dotted `typeName`, `absolute` and the entries
  `{ field, fieldRange, value, optional, range }`. The parser opens one only where every segment of
  the name is an identifier followed by `{`, so `a.in{` and `(a){` stay errors, and each field is
  an identifier. The name is resolved against the **registered types alone** (`construction.ts`),
  `.Name` meaning `Name`, so only a host type that opted in builds a value — the protobuf messages
  cel-spec's own tests construct are not this engine's to build, and a test naming one stays
  dropped from the vectors.

**A dotted declaration is one name, and the longest prefix wins.** A host may declare `a.b.c`, or `a.b`
holding a map, or both; `a.b.c` then reads the variable of that name where it is declared and the map's
entry where only `a.b` is, so the host's own naming decides rather than the shape of the expression. A
name the expression bound takes precedence, exactly as for a bare name — unless the chain is absolute.

**Deliberately still refused**, and these are not oversights: `rb'…'`; a backtick outside a member read,
a construction's field name included; a quoted or absolute name as a namespaced call; container-dependent
resolution of a **bare** name, which would mean inventing a container Telo never declares, and of a
construction's name for the same reason, since one rule for type names and another for every other name
would give an expression two resolutions; and a construction of a language type (`int{}`), of any
protobuf well-known message — `google.protobuf.Any`, the nine wrappers (`BoolValue` … `UInt64Value`),
`Duration`, `Empty`, `FieldMask`, `ListValue`, `Struct`, `Timestamp`, `Value`; not `NullValue`, an enum —
(no protobuf type provider is present; only `Timestamp` and `Duration` add `write timestamp(…)` /
`duration(…) instead`) and of a registered type that did not opt in.

**A single-line literal never holds a line break — a line feed or a carriage return — in any form.** A
raw literal lets a backslash take the next character with it, both kept as written (`r'\''` is a backslash
and a quote) — except a line feed or a carriage return in a single-line literal: there the backslash is
content and the break ends the literal unterminated. An escaped literal's backslash takes the next code
unit whatever it is, so `\` followed by a break is the ordinary `invalid_escape_sequence`. A triple-quoted
literal, raw or not, takes both as content, and a backslash that ends the source is content. A quoted
member name ends unterminated at either too, and the writer refuses a member name holding either.

**`quotedLiteralEnd(source, quoteAt)` is the lexer's delimiting, exported for a host that must find where a
quoted literal ends inside text it does not tokenize** (Telo's `${{ … }}` hole reader). It answers the offset
just past a string, bytes or backtick-quoted literal, or `undefined` when it never ends, deciding the prefix
from the identifier run directly before the quote (`r`, `b`, `br` in any case — never `rb`) and decoding
nothing, so a literal the lexer refuses for a bad escape still ends where the language ends it.
`tests/quoted-literal-end.test.ts` holds it to the lexer over every string up to length 5 of the alphabet
that matters, and pins the prefix rule's explicit rows (a raw marker before a line break), which that
enumeration cannot reach; the two agree on every row the test holds, not beyond it.

**Two cel-go libraries ship and the rest do not.** The **optional** library enters whole under
`enableOptionalTypes` — **whole including its presence reading**: cel-go answers "not found" for a
receiver that is neither a mapper, a lister nor an indexer whenever the read is a presence test, and
its error reading is an explicitly named opt-in (`EnableErrorOnBadPresenceTest`) which Telo
deliberately does not carry, because a per-environment switch over what an expression MEANS would let
the analyzer and a kernel disagree about one manifest. So `a.?b`, `a[?k]` and `has(a.b)` over a value
that holds no members answer absence, and the library's own semantics are the authority for it —
which is the adjudication rule below, applied to a library rather than to cel-spec. The engine
answering the error by default was inventing a dialect inside a library it had declared the authority
for.

`cel.bind` — cel-go's *bindings* extension — is always here too, because a name
for one value is how an expression stops repeating itself and its eight rows are compared like any other.
Every other extension library (`strings`, `math`, `lists`, `encoders`, `sets`, `blocks`, …) is absent: a
call into one is an unknown function. The string members this library declares beyond CEL's own are not
that library — they are its own compatibility members, each saying so in its declaration.

## The reserved set is cel-spec's `RESERVED` — all 21 words, and no others

`IDENT` excludes `RESERVED`, so **no name position reads any of the 21**, and three of them are refused
by being read as something else: `true`, `false` and `null` are literals, `in` is the membership
operator. Accepting one as a name would be a spec violation and would falsify the premise every
consumer of the set is written against — static analysis refuses all 21 as a declared name on exactly
the grounds that CEL cannot read one. That includes the name a leading dot opens: `.true`, `.false` and
`.null` are `reserved_identifier`, exactly as `.while` is, since a tree holding one is a tree the writer
refuses. The split between "refused" and "read as something else" is the
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
- **What each of the four verdicts answers is written once** (`lookupAbsence`), and both presence
  callers read it — so the two backends and the emitter cannot differ about it by construction. A
  **presence-shaped** read — `.?`, `[?]`, `has()` — answers **absence** for *missing*, *out of range*
  and *holds no members* alike, and the error only for an **unusable key**; an **ordinary** read
  answers the error for all four; and the ordinary step of a chain that has entered optional land sits
  between them, absent for a missing key and an error for a value holding no members. An unusable key
  is the one refusal no form forgives: `[?3.1]` names an entry no container of that shape could hold.
- A select on a value that is not a map, a record or a registered type is a type error at check and,
  in the **non-presence** forms, a CEL error at runtime — never a lookup that happens to find
  `length`, `name`, `call` or `apply`. The type error covers **both** forms: an operand whose type is
  known to hold no members is refused whether the read is written `.b`, `.?b` or inside `has()`, so the
  runtime's absence answer is reached only through a `dyn` the check could not judge. A union with at
  least one member-holding branch is the exception, and the reason the rule is shaped this way: a
  presence-shaped read over one is legal and typed `optional<T>` over the branches that hold the
  member, which is how a two-shape field is discriminated with no type test; the ordinary read of it
  stays refused.
- An index on a list is a bounds-checked element read, not a property read.

**A host hands a map over as a plain object, and the boundary of that is the prototype.**
`Object.prototype` or `null` is a map; an object carrying a prototype of its OWN is not, however
data-like it looks, because the seam resolves a key against a value's own entries and cannot tell
a bag from an instance with methods. It is not a theoretical edge: a transport's query bag is
routinely neither (`fast-querystring` builds each one as `new Empty()` over `Object.create(null)`,
so its prototype is a null-prototype object), and read through CEL such a bag held no members at
all — every HTTP handler reading the query string answered 500. **The engine does not widen to
meet it**, and that is the decision rather than an omission: a reading that accepted any
data-like object would make `length`, `call` and `apply` reachable from a computed key, which is
the one guarantee this seam exists for. The host converts at its own boundary instead — one
plain-object copy per bag, which is also where header lowercasing already happens.

## cel-spec is the specification; the vectors are evidence

**Where the conformance vectors and cel-spec disagree, cel-spec decides.** A `language.json` row's `expect` is this engine's whole answer, and the format carries cel-spec's own answer under `deviation.celSpec` — only the parts where the two still differ, each with a `reason`. So a row records what runs, and a row's own `deviation.celSpec` is the authority for what the language means there.

**The bound on that authority:** `deviation.celSpec` binds where **cel-spec's language definition** fixes the meaning, or where **a library Telo enables** does. Outside it the engine's answer stands, and says why. A row whose `deviation.uncarried` holds `disable_check` says nothing about checking at all.

**The reasons are four, and a closed set** (`DEVIATION_REASONS` in `conformance/language-replay.ts`): `extension-library`, `feature-not-carried`, `container-not-declared`, `uncarried-input`. Every one is a fact about the row's **input** — a library this engine does not ship, a cel-spec feature it does not carry, a container Telo never declares, a declaration the format could not carry — and a fact about the input still has to be TRUE of the row. A disagreement about what the engine itself computes, reports or prints is not a reason: it is a defect to fix, and the row then records the fixed answer with no `celSpec` (`evaluation-answer`, a fifth reason, is gone for that reason). The driver checks, per row: `reason` exactly when `celSpec`; every stated part disagrees with the answer (an agreeing part fails, instructing to drop it — so a row cannot keep an exemption after the engine was fixed); `uncarried-input` with a non-empty `uncarried`; `container-not-declared` with `container` in it.

**The blind spot is the point of the design, and it is written down:** deep equality of `expect` pins whatever this engine answered, so a row with no `celSpec` was either agreed with cel-spec or never asked of it. `catalog/addMonths/result_before_range` pinned a wrong value (a timestamp in 1900, from `Date.UTC` reading year 0 as 1900) until the calendar was fixed, with the row green throughout — and no `celSpec` on a dialect row is a check against cel-spec at all. Reading a row for a defect without first looking at its `deviation` is how a false finding is made.

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
language's own casing rather than touching the ASCII letters alone. Both are what the vectors
record for them — the engine's own answer, since cel-spec is silent about a member it does not define.

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
every engine, and the vectors record 60 of them verbatim. It is never a library's wording or the host
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
level is reached through a reference and merged out of two `allOf` halves). **An intersection's
cost grows linearly with the depth of the shapes it composes**, counted rather than timed — the
holders the containers it built keep (`heldHolders`), the containers built (`builtContainers`) and
the entries of the readings built (`readsEntries`), each within 2.5× per doubled depth on a chain
meeting the level below with itself, on two chains of equal content and on a chain of unions —
because a conversion answers each meet once, the ROBDD apply pattern: **holders are interned** by
the side, member and typing they stand for and **kept canonical** (each distinct holder in
first-occurrence order, at most twice — twice already says several parts hold a member).
**Unique table.** Every type a meet builds is interned per conversion. A container is keyed by its
kind; the identities of its members (fields, element, value, positions, rest, pattern parts);
`fieldEnums`, `absentFields`, `additionalFields`; for each member, its canonical holder list; and
for each absent name, its canonical holder list and whether some part declares it absent. A union is
keyed by its members' identities in order. The key covers every side-table entry that placement or
the listing reads. A second meet producing an equal key answers the interned type, whose side tables
are written once. **Each meet is answered once** per conversion by (left, right, orientation) (the
computed table, which also holds the meets nothing observes), a repeat pushing the one reading its
comparison recorded where the meet would have pushed it and marking again a pass past
`UNION_EXPANSION_LIMIT` — so `(X∧X)∧(X∧X)` meets pairs met before and answers `X∧X`, its key equal
to `X∧X`'s. **An interned union is never placed.** Each node read whose own type is a union a meet
built places a shallow copy of it at that node. The copy costs at most `UNION_EXPANSION_LIMIT`
members, once per node read. Containers built by a meet keep the interned union. And **readings are
a shared graph**: a joined reading holds its parts rather than a copy, and a check lists and reads
each part once, in the order the copy would have been read, so listing a read through the met type
is linear in its depth too. Negative controls, recorded with the gates, red in both engines:
dropping the unique table turns every diamond gate red; dropping union interning alone turns the
union-diamond gate red; placing the interned union at the first node read (instead of always
copying) turns `union_meet_field_after_node` red; copying no union turns
`union_meet_second_node_unknown` and `union_meet_field_after_node_unknown` red; replaying nothing on
a computed-table hit turns the `meetSharing` rows red.

**A walk over a type visits each distinct type object once.** Type graphs are shared: a reference is
read once, and a meet's results are interned. So every whole-type walk memoizes by identity for the
duration of the call: one-type walks (`withoutParameters`, the result origins' `holdsOptional`, the
equality operands' null removal at every depth) answer each type object once. Equality,
assignability and the join answer at once when both sides are the same object, and answer each
identity pair once. The meet answers each identity pair once, through the computed table, and never
answers at once on the same object. A member that several parts type, including equal parts and one
shape reached twice, is placed nowhere, so a type met with itself is not the type alone (the row
`telo/meetSharing/one_shape_met_with_itself_at_a_read`; the identity shortcut in `intersectTypes`
turns it red in both engines). The environment digest's writer writes each distinct type once and
refers back to it after that. Type graphs hold no cycle (recursion is the declared `dyn`), so a memo
of results is enough. Counted, not timed (`typeVisits`, `tests/checker-cost.test.ts`): on `d_i =
{properties: {a: {$ref: d_{i-1}}, b: {$ref: d_{i-1}}}}`, the visits registering it and checking `x`
or `x.a.b.a` make satisfy v(24) ≤ 2.5·v(12) and v(48) ≤ 2.5·v(24), and a check of `x` at depth 64
completes; dropping the memo from `withoutParameters` alone turns the gate red, and so does dropping
it from `holdsOptional` alone.

**A printed type is written whole up to `TYPE_TEXT_NODE_LIMIT` type nodes, then cut.** The limit is
64, declared as data beside the union expansion limit (`src/type-text.json`) and read by both
engines. Printing walks the type in pre-order: a union's members in order, a container's arguments
in order, and a record as its one name. Each type node written counts one. The node that would
exceed the limit is written `...` and printing stops there, every open bracket closed. So the text is
bounded by the limit and the depth, whatever the type's size. One formatter serves `typeName` /
`format_type` in both engines and every message that names a type, so a check result and its
diagnostics always print a type the same way. Nothing reads a printed type back as a type, since the
digest has its own writer and fitting a value never compares printed names. A union writes only its
members, so it counts none of its own.

**A printed type is display only, and nothing decides behaviour from it** — no parse, no equality, no
lookup keyed by it, a one-node name included. A reader that branches on a type reads the CEL type:
its `kind`, and the engine's own predicates and registry. A type read from type-expression text (a
signature, a parameter, a declared variable) is a tree linear in that text, so `exactTypeText`
writes it whole. That is its identity in a signature's text, a dispatch key and the environment
listing. A type converted from a schema has no printed identity. The environment digest's writer
identifies it, each distinct type written once with back-references. The cut formatter displays
it, including the namespace listing's `name(…): <returns>` line for a result declared as a schema.
`NamespaceListing.functions` lists each function as `{ declaration, resultType? }`: `declaration`
is the signature, or `name(…): <result>` cut past its bound; `resultType` is the CEL type of a
result declared as a JSON Schema, present exactly then, and the digest reads it structurally. A
named type's arguments are compared as types (`typesEqual`, invariant, memoized), never by printed
text. An unnamed record prints as `map`, so comparing by text made `Name<{a: int}>` equal to
`Name<{b: string}>`. That contradicts the declared invariance of type parameters, and it costs the
size of the printed tree. So a host reads a type, never its text: a namespaced call's
`ResolvedCall.argumentTypes` holds the argument types themselves and `argumentTypeNames` the text
each prints as, and `convertsToString(type)` answers whether `string(x)` over the type resolves, as
the checker resolves a call — as written, then over a union's members.

Rows `telo/typeText/<case>` pin a type of exactly 64 nodes printed whole, one of 65 cut at the 65th,
and the `oneOf` array/object diamond 16 deep with its cut text; `telo/typeArguments/records_of_two_shapes`
pins two records as a named type's arguments refused as `CEL_TYPE_ARGUMENT_MISMATCH`, red under text
comparison. The printing gate holds the printed type of `x` at depths 16, 32 and 64 to exactly 64
type nodes followed by one `...`, its length within one constant the test declares, the same at
every depth, a check of `x` at depth 64 completing; a namespaced function whose result is that
diamond declared as a schema lists in the same bounded text, its digest work linear in depth, and
two such results differing past the cut digest apart. Removing the cut turns the depth-16 row and
the gate red.

**Nothing a schema says may fall through to `dyn` in silence**, and that is a stronger rule than "every
keyword is read". The conversion answers a type **plus a report of every node it could not judge**, each
by JSON Pointer (`UnjudgedSchemaNode`, reached through `environment.schemaReports()`), with one reason
from a closed set: `keyword-not-read`, `shape-not-read` (`prefixItems` beside `additionalItems` or an
array `items`, a `type` naming no JSON type, a `not` whose subschema says more about a type than `type`,
`const` and `enum` do, a `patternProperties` pattern RE2 refuses, and a meet whose unions would build more
than `UNION_EXPANSION_LIMIT` members),
`reference-unresolved`, `intersection-empty`, and `named-type-unregistered` — the host's resolver naming
a type that is neither one of CEL's own nor registered, which is the host disagreeing with itself and was
the one silent fall-through left after the rest: the structural reading still stands and the disagreement
is reported beside it. **A name the resolver answers is read as the type-expression grammar reads a name**
(`resolveTypeName`, the one resolution the grammar and the conversion share): CEL's own types first —
`bytes`, `uint`, `list`, `optional`, the well-known `google.protobuf.Timestamp` and
`google.protobuf.Duration` — then the registered ones, its arguments read as type expressions, so a node
answered `bytes` is `bytes` at any depth of the schema rather than a fall-through to its structure. It **reports rather than refuses** because a node it cannot type is usually a third party's
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

**A record's undeclared members have a type of their own** (`RecordType.additionalFields`, absent on a
closed record): `properties` beside `additionalProperties: <schema>` types every member the record does
not declare as that schema, `true` as `dyn`, and `false` — or no `additionalProperties` — closes it. So
a select, a literal-key index, `.?`, `[?'k']` or `has()` of an undeclared member is typed
`additionalFields` (its `schemaNode` and dependency the `additionalProperties` node), and on a closed
record it is `CEL_UNKNOWN_FIELD`. A computed-key index reads any member the record may hold: the **union**
of every field type, every pattern entry admitting a value in every part, each part's `additionalFields`
and the record's own — `dyn` where one of them is `dyn` or the record holds none — each type kept with
its node, so the read gives one origin per distinct node and `x[k] + 1` over `{a: string, b: integer}`
is refused naming the `string` combination. **A record stands wherever a string-keyed map does** — its fields, its patterns' types and
`additionalFields` are each judged against the map's value type, `dyn` assigning anywhere — so `'k' in
self.m` checks over one, and one declaring an `int` field is still refused as a `map<string, string>`
argument. There is no `open` flag: whether a record is open is whether it carries `additionalFields`.

**`patternProperties` is read by JSON Schema's applicability, one schema part at a time**
(`RecordType.patternParts`, absent rather than empty). Each part carries the entries one schema part
declares, in written order — a pattern and the type it gives, absent on an entry admitting no value — and
its `additionalFields`: the type the part gives a member another part's pattern matches and none of its
own does, absent where the part is closed or open to anything. A record read from one schema node has one
part with no `additionalFields`. A pattern is matched as `matches` reads one — RE2, unanchored search —
and one RE2 refuses (a lookaround, a backreference) is `shape-not-read`, keyword `patternProperties`, at
the record's node: no pattern of it is read and every member the record does not declare is `dyn`; that is
the only report patterns raise. A member read by a literal name (`.`, a literal index, `.?`, `[?'k']`,
`has()`) is typed by its `properties` entry where there is one (already met at conversion with every
pattern matching it); otherwise, where some part's pattern matches it, by the meet over the parts of each
part's matching entries, else that part's `additionalFields` (a part carrying neither says nothing); and by
the record's own `additionalFields` only where no pattern matches. It is placed at the one node that
applies (`…/properties/<name>`, `…/patternProperties/<pattern>`, or the `additionalProperties` a part's
undeclared members came from) and nowhere where several do, the read listing each (a meet at the read
lists each type whole, since nothing placed beneath it). A pattern admitting no value makes every name it
matches absent, and so does a meet that cannot hold. A closed record refusing a name lists its patterns,
each text once (`"x" is not declared here (declared: a1), and matches none of its patterns (^a)`). One
record with patterns stands where another does exactly when the two are equal: two records differing only
in a pattern's text are different types, so a conditional joins them as a map. Record equality compares
parts in any order, each by its `additionalFields` and its patterns by text in any order; the environment
digest writes each part with its entries sorted and the parts sorted, the own-type agreement carries a
node's pattern texts beside its property names, and `schemaDependencies` carries a pattern edge per part
and entry position and one per part's `additionalFields`, keyed so no property name can stand for one.

**A schema that admits no value is absence where absence can be stated** — `false`, `not: {}`, `not:
true`, a conditional neither branch of which can hold. At a property the member is declared absent
(`RecordType.absentFields`, never a declared field, absent rather than empty): every read but a presence read is `CEL_UNKNOWN_FIELD` naming the property's node and
marked `absent: true`, so a host tells it from an undeclared member without reading its words, open record or closed, while `has()`
is `bool` and `.?m` / `[?'m']` `optional<dyn>`; a union member declaring `m` absent counts as a shape
lacking it. A closed record keeps its absent names, because closed means undeclared to the reader, not
excluded from the value, and the field-wise `allOf` meet depends on the difference. At
`additionalProperties` it closes the record (`{not: {}}` and `false` are one type), at
a tuple's rest it closes the tuple, at a position it ends the tuple there, and a union branch admitting
none is dropped. **So does every meet that cannot hold at a member position of a container a meet
builds**: a field met with a pattern, with another part's `properties` entry, or with two patterns at a
read becomes absent; a pattern entry admits no value; undeclared members that cannot meet close the record
(as a part's `additionalFields`, it is absent); a plain list's element becomes a tuple of no positions and
no rest; a map's value makes it a closed record of no fields. A node whose own parts cannot both hold (two
scalars, say) admits no value and is read as absence by its holder. At a registration's root it has
nowhere to be stated and is `intersection-empty` — the one place that reason is raised.
`not: {required: [m]}` is no absence: `required` constrains a value.

**A declared field whose schema admits a finite set of values carries that set** (`RecordType.fieldEnums`,
absent rather than empty, never an empty set, never for an undeclared field): a `const`, an `enum`, or a
union (`anyOf` / `oneOf`) of them, `null` among them — each value a scalar, read as the field's type reads
it, an integral JSON number an int at an `integer` field and a double at `number`, a value the type cannot
hold dropped and a field none of whose values it holds carrying none. Each set is held in canonical order
(null, bools, ints, doubles, strings by code point; a double's negative zero is zero) and is part of the
record's type: record equality, the environment digest and the own-type agreement (which reads an `enum` as
the set of its values beside the order its values' JSON types first appear in, the order of the union it
reads as) all compare it as a set, so two shapes differing only in a constant are two members of a union.
A meet intersects the sets — `allOf` of `k: enum [a, b]` and `k: enum [b, c]` is `{b}`, and a `number` set met
with `integer` keeps its integral values as ints — and an empty
intersection makes the field absent, at a node met with itself and at a record meet alike; a field whose
values are not finite, a pattern entry and a record joined as a map carry none. `not` takes no value out of
a set: one wider than the node admits is still sound for every reader of it.

**A tuple is a list carrying its positions** (`ListType.prefixElements`, and `additionalElements`, the
type of every element past them, carried only beside them; `tupleOf` is the one constructor). Draft-07
spells one `items: [...]` with `additionalItems`, 2020-12 `prefixItems` with `items`; in both an absent
rest keyword is a `dyn` rest, `false` none, and a schema the rest's type (its node the rest's
`schemaNode`). `element` is the join of every position and the rest, so every reader that does not ask
for a position — a computed index, `size`, `in`, a comprehension, assignability to `list<T>` — reads the
union, and only a literal index reads a position: inside the prefix that position, past it
`additionalElements`, and past a closed tuple `CEL_TYPE_ERROR` (`<type> holds <n> positions, and index
<i> is past them`; a presence index answers absence). Assignability is element by element and position
by position where both declare one; two tuples of as many positions join position by position, their
rest the join of the rests they have. `items: false` alone is a tuple of no positions and no rest.
`prefixItems` beside `additionalItems` or an array `items` is `shape-not-read`. A printed tuple is
`list<A|B>`.

**`not` takes out of a type only what it excludes wholly.** `not: false` constrains nothing; a subschema
holding only annotations admits every value, so the node admits none (above). A subschema whose type
keywords are only `type`, `const` and `enum` removes each union member it accepts wholly — its `type`
covers the member and no value keyword narrows it, or its `const` / `enum` lists every value the member
has (`null`; `bool` only with both `true` and `false`) — and removing every member admits no value;
otherwise the type is unchanged and exact, with no report. So `type: [string, "null"], not: {type:
"null"}` is `string`, and `not: {enum: [...]}` over strings or `not: {required: [...]}` is the node's
own type. A subschema carrying any other type keyword is `shape-not-read`, keyword `not`.

**`if` / `then` / `else` is read as one part of the node's own type**: the union of `if` met with `then`
(`{}` where absent) and `else`, a branch whose meet is empty dropped and both dropped admitting no value;
with no `else` it says nothing, and `then` / `else` without `if` are read as absent. The three nodes are
read whole, so a read of the holder lists them all.

**`allOf` intersects, and so does everything else one node says about its own type.** Records merge
field-wise and a narrower scalar wins — JSON Schema's `integer` being a `number`, an `int` or `uint` met
with a `double` is the integer — so a reference beside a `properties` block, or two partial records,
compose; a field of each half is read and a third is `CEL_UNKNOWN_FIELD`; a field one side declares meets
the other side's pattern parts' reading of it, else its `additionalFields` where those are a type other
than `dyn`; a name either side declares absent is absent, the undeclared members meet, and closed wins
over open — and any of those meets that cannot hold is absence (above), never a contradiction silently
resolved one way. **Each part's patterns stay that part's**: the met record carries both sides' pattern
parts, a side with one part or none as one part whose `additionalFields` is that side's undeclared members
where they are a typed schema other than `dyn` (a closed part, or one open to anything, constrains nothing
another part's pattern matches, so `allOf: [{patternProperties: {'^a': string}}, {properties: {b: {}}}]`
reads `x.ab` as `string`), a side met before keeping its parts. A part with neither patterns nor undeclared
members is dropped; parts with the same pattern texts are one part, their entries met by text and their
`additionalFields` met — except parts whose `additionalFields` cannot meet, which stay apart, since a
member only another part's pattern matches must hold both (merged, the failed meet would drop the
constraint); parts with no `additionalFields` are one part; and a part left alone carries none.
So every `allOf` of pattern-carrying records is read exactly — under part A (`^x-`, a typed
`additionalProperties`) and part B (`y-`, closed), `x['y-1']` is B's pattern met with A's
`additionalProperties` — and `allOf: [S, S]` is S in type and digest, parts included. **Each member is read from the part that
types it**: one a single part types other than `dyn` — through its `properties` entry, or its
`additionalProperties`, element or rest standing for the member — is placed at that part's node
(`schemaNode`, `resultOrigins`), and so is one a single part holds as `dyn` where no part types it; one
several parts type, equal parts included, was built by the intersection and is placed nowhere, its read
listing every declaring node; a part an earlier meet built stands for every part it was built from; a
member declared absent is placed at the first part, in written order, declaring it so; and an undeclared
member of a closed intersection is refused at the node holding the `allOf`. This holds at every member
position of every container a meet builds — a record's field and undeclared members, a list's element, a
tuple's positions and rest, a map's value. Two equal containers still meet member by member, and two equal
unions meet member by member at matching positions (the pairing their equality already fixes), so the met
type equals each part's and no part stands for another. **A union meet distributes, and is bounded**:
a union met with a type it is not equal to meets each of its members with that type, so `n` unions of
two shapes build `2^n` members; a meet that would build more than `UNION_EXPANSION_LIMIT` (the call
expansion's bound, `src/union-expansion.json`) stands as the one type joining every member of its
operands, and the site holding it — an `allOf`, a node's own parts, `if` with `then`, a property met
with its patterns — is read as that join of what it met, wider than the meet so no read the meet admits
is refused, and reported `shape-not-read` at its node with the keywords met. **`enum` and `const` with no `type` are
read from their values' JSON types**, which is what makes a constant beside a host-typed branch a `string`
rather than a `dyn` that collapses the whole union.

**The type join agrees with assignability about what a record is.** A record is a map with named keys and
stands where a string-keyed map does, so where two types are reduced to one — a conditional's branches, an
aggregate literal's elements — a record meeting a map, or a record of another shape, joins as that map: the
key is `string` joined with the other side's key type, the value the join of every field type with the
other side's value type, `additionalFields` among them. Equal records stay that record, and a record against a
scalar or a list is still nothing in common. Answering "not one type" for a record beside a map literal
refused an expression the same engine would have accepted as an argument.

**Null is joined apart, and a union absorbs what it includes.** The join takes null out of both sides,
joins the rest by the rules above, and adds null back where either side admitted it; a side that is only
null joins as the other side plus null. So `c ? x : null` is `T|null`, `[x, null]` is `list<T|null>`,
`c ? n : 1` with `n` an `int|null` is `int|null`, and `map|null` beside a `map<string, string>` joins as
the maps do, plus null. A union joined with a type it includes is that union (`int|string` with `int` is
`int|string`). **A union joined with a type it does not include widens by kin**: against the other side —
the right one where both are unions — one member at a time, a member that stands where some member of the
union does is absorbed, one whose join with some member of the union is one type is kept as a member of its
own, and one with nothing in common with any makes the join "not one type"; the members stay in written
order, the union's all kept. So over `ms`, a list of a union of two closed records, `[{'a': 'x'}] + ms` is
`list<map<string, string>|map|map>` and `ms + [{'a': 'x'}]` lists the records first, while `c ? true :
ms[0]`, `c ? (int|string) : (int|bool)` and `[1] + ['a']` are still refused. Two non-union types join as
above, and anything else with nothing in common is still "not one type" (`c ? 1 : 'a'`): a reader would be
reading two things.

**A flat field map is still accepted** (`{ fields: { columns: "map" } }`). It is not a convenience: a
consumer replacing an older engine has to reproduce its verdicts exactly before it turns deep typing
on, and a converter that only ever goes deep would force every such consumer to become stricter on the
same day it changes engines.

**A named type is not its base.** `registerType` takes a name over a base with its own operators,
comparisons, conversions, members and **invariant** type parameters, and a value of the base does not
stand where the named type is wanted — which is exactly what a slot wanting one must refuse, and what
an engine typing by wrapper class cannot express. A type argument that differs is
`CEL_TYPE_ARGUMENT_MISMATCH`, not a widening. `Self` inside a definition names the type being defined.

**A named type may declare FIELDS** (`NominalTypeDefinition.fields`, a name → type expression),
carried on the registered type itself (`NominalType.fields`) so every reader holding the type knows
them. They are read by `.`, `.?`, `has()` and a literal index, typed as declared; a name the type
does not declare is `CEL_UNKNOWN_FIELD`, as a closed record's is, and a type declaring none still
holds no members. At evaluation a value carrying the type's key is read through the one member-read
seam, which answers a declared field from the value's **own** entries — absent is `no_such_key`,
or absence in a presence form — and answers nothing else of it, its type key included: the seam is
handed the environment's field table (`CompileTarget.nominalFields`, `HostFields`), and both
backends take the member reads bound to it (`memberReadsOf`), the emitter's runtime under the
seam's own names so the emitted text is the same whatever an environment declares. A conversion
such a type needs (`string(Self)`) is the host's ordinary `registerFunction` with an implementation,
dispatched on the value's own key. The environment digest carries each type's fields.

**A named type may opt in to CONSTRUCTION** (`constructible: true`, beside `fields` — an empty set is
a type with none — and with no `parameters`, since the syntax has no place for a type argument), and
list the fields a construction must write (`required`, each a declared field; a type that is not
constructible listing any is refused, `<Name> lists required fields and is not constructible`). `Name{field: v}` then
checks as the type: an undeclared field is `CEL_UNKNOWN_FIELD`, one written twice
`CEL_INVALID_ARGUMENT`, a value not assignable to its field `CEL_TYPE_ERROR`, and a required field
omitted or written `?field:` `CEL_MISSING_FIELD`; a name no type is registered under is
`CEL_UNKNOWN_TYPE` even under `unlistedVariablesAreDyn` (nothing can be constructed from `dyn`),
naming the nearest constructible names, and a language type, a well-known type or a type without the
opt-in is `CEL_TYPE_NOT_CONSTRUCTIBLE`, worded by cause — the last naming the registered functions
returning the type, nearest first. Every bound and order is `nearestCandidates`', the one the
unknown-function candidates use. `registerType(definition, { construct })` may supply a **builder**,
called with the call context first and the written fields as a plain object, unset ones left out,
answering a value or a CEL error value — so a host whose values carry an invariant can still be
constructible; without one the engine builds `{ [CEL_VALUE_TYPE]: name, ...fields }`, the form a host
builds. **An unset field reads as absent**, as on a host-built value. A builder's answer is a door a
thenable comes through. Unchecked, both backends answer a refused name `no_matching_overload` and a
refused field `invalid_argument`, in the check's own words, after evaluating the values
(`ConstructionSite`, `backend-runtime.ts`); `required` is the checker's alone.

**Every construction then holds each written value to its field's declared type**, checked and
unchecked, both backends, before a builder is called or the engine builds: the value's runtime type,
taken as dispatch takes it (a container's elements `dyn`, a named type's arguments `dyn`), must pass
dispatch's own loose argument test (`argumentFits`) against the declared type — so a `dyn` list into a
`list<int>` field is admitted, as it would be at a call, and a `dyn(1.5)` into an `int` field is not.
The first refused value in source order is `invalid_argument`, `field "<name>" of <Type> is <declared
type>, and this value is <runtime type name>`, ranged over that value; an absent `?field:` is not
tested, a field declared `dyn` is skipped at compile, and a field remembers the type name it last
admitted, so the test costs one type-name read whatever the value's size. A builder's answer is not
re-checked.

**A constructible type is compared field by field, and nothing else may compare it**: being
constructible is the promise that a value is its fields, while any other host value may hold state the
engine cannot see and stays equal only to itself (a host `==` over one replaces as for any type). The
type declares `==` and `!=` over itself with no implementation, answered by the one equality, which
compares the type key, which declared fields are present, and each present pair; direct `==`, `!=`,
`in` over a list, list, map and optional equality and the catalog's `distinct` all read it, because the
call site hands the environment's constructible-field table (`ConstructibleFields`) to the engine's own
implementations through its context. **A host override has no home**: one that won at a direct call
while a list holding the same values stayed field-wise would give one pair two answers. So an `==` or
`!=` registration — `registerFunction`, `registerOperator` or a type's own declared operators, with or
without an implementation — whose either parameter, read at top level (the type, `dyn`, a bare type
parameter, or a union with a member that is one; a container is not read inside), accepts a
constructible type is refused with `CelTypeRegistrationError`: `<signature> cannot be registered: it
would compare values of <T>, which is constructible, and a constructible type's values are equal exactly
when their fields are; normalise the fields in its builder, or register <T> without constructible`, `<T>`
the first such type by name. And `constructible: true` is refused while such a registration is held,
other than the type's own `(Self, Self)` comparisons: `<T> cannot be constructible: <signature> is
registered and would compare its values, and a constructible type's values are equal exactly when their
fields are`, the first by signature key (`construction.ts`). No standard-library `==` trips it. The
digest carries `constructible`, `required` and whether a builder is present.

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

**It decides every verdict, with a range, and nothing reads a message.** The twelve CEL codes plus the
three namespaced-call codes are each decided where the cause is known — an unknown name, a call written
in the other form, an argument type no overload takes — which is what lets the after-the-fact classifier
beside the engine being replaced disappear. **A fix is a whole-source replacement**, built by rewriting
the tree and writing it back out, so a repair always parses and never depends on an offset that
re-indenting would move.

**A call on a name nothing registers names the names that would have worked** — the registered names
accepting its form and arity, at most `UNKNOWN_FUNCTION_CANDIDATES` of them, by edit distance over the
name as written then by name. The bound and the order are **declared** because the vectors pin the
message byte for byte, and a selection rule a second engine cannot reproduce is a row it cannot pass; a
name that cannot be written as a call (an operator's own symbol) is filtered out rather than ranked —
without that filter `no(1)` offered `!` and `-` as its nearest spellings. It names **no command**:
which listing a host offers is the host's, and the same engine embedded somewhere with no CLI could not
honour it. The fix beside it stays **singular** — a list of five repairs is not a repair, and the
alternatives are already in the message.

**A call resolves in three passes: exact, loose, then expansion over its unions.** The exact pass takes
the first overload every argument is assignable to; the loose one admits a `dyn` argument and answers
`dyn` where the viable overloads disagree on their return. Only where both fail is each union-typed
receiver and argument expanded into its members (`function-registry.ts`, `resolveExpanded` — mypy's
"union math"): every combination, in member order with the receiver and then the arguments left to
right, must resolve, and the call is typed as the union of the combinations' returns (`dyn` if one is),
each distinct overload listed once in combination order. So `type(string|map)` and
`string(Duration|Timestamp)` check, while `string(int|null)` and `int|null + 1` are refused with the
refusal as written plus `; <combination> is taken by none` — `string(null)`, `null, int` — whose
`schemaNode` is the node of the member the failing combination took. Running last is what keeps every
answer that resolves as written unchanged: `wrap(A): list<A>` over `string|int` is still
`list<string|int>`, not `list<string>|list<int>`. At most `UNION_EXPANSION_LIMIT` (64) combinations are
tried, **declared as data** (`src/union-expansion.json`) because the refusal past it is pinned by the
vectors: `<call> holds more than 64 combinations of its arguments' types; narrow one with a type test`.
A call reaches at most `CALL_SITE_DIRECT_ARITY` positions, so the limit is met by unions of three
members or more, and a call no overload's arity takes is never expanded.

**A type parameter bound at several arguments takes their join.** It is bound by the first argument that
mentions it; a later argument that does not fit the binding widens it to the join of the two — the
conditional's join, null apart, a union absorbing what it includes and widening by kin — and is refused
exactly where that join is "not one type". So `xs + ys` over a list of string maps and a list of records is a list of their
join, and `[1] + ['a']` is still refused. A binding holding only an unresolved parameter is replaced
outright by a later concrete argument, as before: `optional.none().orValue(42)` is an `int`.

**A comprehension over a union iterates every member**: where each is a list or a map (a record
included), the bound name is the union of each list's element and each map's key; a member that is
neither is refused, naming it (`a comprehension reads a list or a map, and string, a member of
list<int>|string, is neither`). The engine has no two-variable comprehension form to extend.

**A read that yields an optional (`.?f`, `[?k]`, or any select or index whose operand is an optional) is typed `optional<held>`, and an optional held value is NOT flattened** — `{'a': optional.of(1)}.?a` is `optional<optional<int>>`, as the runtime nests it. A chain `a.?b.c` still does not nest, because each step reads through exactly **one** optional layer of its operand; an operand that would be read through more than one optional layer — `optional<optional<…>>`, or an optional branch of a union beneath an optional — is refused naming the whole operand ("is read through one optional only; unwrap the inner optional …"), as the runtime refuses it. A dotted declaration's segments follow the same rule as a select.

**A guard is one of three constructs, `?:`, `&&` and `||`, over three tests** (`nullable-access.ts`):
`<chain> != null` / `<chain> == null` prove the chain is not null, `has(<chain>.<m>)` proves it holds
`m`, and the type test `type(<chain>) == <T>` (or `<T> == type(<chain>)`) proves the chain is of the
members whose runtime type is `T` where it holds and of the others where it fails; `!=` and `!` swap
where each holds. `<T>` is a name the environment resolves to a type value (`string`, `list`, `map`,
`google.protobuf.Timestamp`, `optional_type`, a registered type's name) and not rebound by a macro, or
`type(<e>)` whose `<e>` is typed neither a union, `dyn` nor a bare parameter; anything else proves nothing,
so the test is decided only once the comparison is typed. A member's runtime type is what `type()` answers
for it — `list` for any list, `map` for any map or record, the primitive, the well-known type, a registered
type's name — and a `dyn` or parameter member stays on both sides. `xs.map(e, p, t)` lowers to the ternary
`p ? [t] : []`, so its transform is checked under what `p` proves. Any other guard written as a call is
deliberately not proof.

**A discriminant test is a fourth test**: `<chain>.<m> == <lit>` (either order), `!=`, and `<chain>.<m> in
[<lit>, …]` with every element a literal, the member read by a literal name, `.m` or `['m']`, and a literal a
string, int, uint, double, bool or null literal, a negated number included — a bytes literal or anything
computed proves nothing. Where the test holds `<chain>` is the members whose `m` can equal a listed literal:
its set holds a value the runtime's own `==` finds equal (`celEqual`), or with no set `m`'s type is one a
listed literal's value can have (the numeric types one another's). Where it fails `<chain>` is the members
whose `m` can hold a value outside them: no set, or a set not within them. A closed shape that cannot hold
`m` (or holds no members at all) is dropped on both sides; an open record not declaring it, a map, an
optional and `dyn` are kept on both; whether `m` is required is never read. Where the test holds and no
listed literal is null, the compared chain itself narrows to its members a listed literal's type can be
(`x == 'a' ? x.size() : 0` over `string|int`); a test against null leaves the compared chain to the null
test, so a dereference stays the nullable read it was. Composition and the rebinding rule are the other
tests'. So over `u`, a union of closed `{k: const a, p: integer}` and `{k: const b}`, `u.k == 'a' ? u.p : 0`,
`u.k != 'b' ? u.p : 0` and `u.k in ['a'] ? u.p : 0` check, while `u.k in ['a', 'b']` or `u.k == 'c'` leave
both shapes and the read is refused.

**What is proven narrows the chain wherever it is read** — as a dereference's operand, and as a value,
an operand or an argument: a chain proven not null is typed without null, and one `has()` proved holds
`m` is typed as only the shapes that can hold `m` (a shape declaring it, an open one, a map), located at
the remaining branch's node. So `note == null ? '-' : note` is `string`, `hint == null ? null :
hint.lowerAscii()` checks, `type(u) == string ? u.lowerAscii() : ''` checks over `string|map`, and a
conditional's origins carry each branch as narrowed. A narrowing that would leave nothing leaves the type
as it is. Narrowing costs one lookup in the proven set per plain chain, and nothing while no guard is in
scope.

**Equality and membership are judged by overlap.** `null` is comparable with every type, so `==` / `!=`
with a side typed `null` is `bool` whatever the other is (`m == null` over a map) — or declaring a value
nullable would make it untestable. Otherwise, where the comparison does not resolve as written nor with
null taken out at every depth, it checks when some member of one side and some member of the other resolve
it (`int|string == int|bool`), and `1 == 'a'` is still refused with the refusal as written. `in` over a
list judges its element by overlap against the list's element members, over a map against the map's key
members, and a union container is expanded as a call is, each member having to take the element.
Ordering and arithmetic are expansion's, so they stay refused over a nullable.

**Every plain chain is a subject**, a comprehension variable's and a `cel.bind` name's as much as a
declared one's: `xs.map(e, e.code.n)` over a nullable `code` is `CEL_NULLABLE_ACCESS`, because the read
fails when it runs.

**A proof does not cross a rebinding.** A proof whose chain is rooted at a name a macro or `cel.bind`
binds is dropped inside that binding's body, so `x != null ? xs.map(x, x) : []` does not narrow the inner
`x`, which is another value. **An absolute chain is its own spelling** (`.x.a`): it names the
declaration, so no binding drops a proof of it, and a chain whose root nothing binds where it is
read is held under that spelling too — so `x.a != null ? [1].map(x, .x.a.b) : []` checks, while a
guard on `.x.a` proves nothing of a bound `x.a`, nor the reverse. A host's `rebound` chains are bare
names and never drop a proof of an absolute chain.

**A member only some shapes of a union declare is absent from the closed shapes lacking it.** A presence
read (`.?m`, `[?'m']`, `has()`) asks exactly that and is judged against the shapes holding `m`; any other
read of it is one `CEL_UNKNOWN_FIELD` per read, naming `.?m` as the repair, whose `schemaNode` is the node
holding the union — and, where the operand is a plain chain and a field every shape declares with a finite
set tells the shapes holding `m` from the others (their values disjoint by the runtime's `==`; the first such
field in the first shape's written order), the test as well: `… or read it behind the test that tells the
shapes apart (u.k == "a" ? u.p : …)`, an `in [...]` where several values apply, each written by the
serializer. A shape that is open, or a map, holds any member and is never a reason to refuse, and a
shape holding no members at all keeps its own refusal.

**A host hands what is known at the site in as `assumptions`** (`check(source, { assumptions })`), each
`{ condition, holds, rebound? }`: `condition` a source this environment parses or a tree its `parse`
produced (one resolved under another namespace set is `namespaces_mismatch`, as the expression would be),
`holds` whether it held on the way to the site, and `rebound` the chains that may denote another value there.
Each is read in order as if a `?:` enclosed the expression — its condition typed under the assumptions
before it, so a type test it holds is decided, with nothing it says reported, listed or located (it is the
host's own site to judge) — and its where-true or where-false proofs, by the one proof reader, are in scope
for the whole walk, but for a proof rooted at a `rebound` chain (the chain, or one beneath it), which is
dropped; the in-expression rebinding rule applies on top. The vectors' rows carry them as `assumptions`.
Which conditions guard a site is the host's to read; the engine reads only the CEL it is handed.

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

- **A type name nothing is registered under is accepted and read `dyn`**, and every call to that
  function carries a ranged `CEL_TYPE_ERROR` naming it. A declaration is a host's own data — a module
  function's declared result, out of a manifest — so a typo in one is the host disagreeing with its own
  registry, reported where there is a range rather than thrown where there is none, exactly as
  `named-type-unregistered` is for a schema node. It covers every type position of both declaration
  forms, because leaving one form throwing for the identical typo is the asymmetry this guide calls a
  finding. `CelTypeExpressionError` keeps what it is about — text this grammar cannot read — and
  `CelUnknownTypeNameError` is what a caller holding its own source gets.

**Why the engine declines rather than answers:** a host's name resolution can rest on vocabulary this
package may not learn (an export gate, a capability, a re-export chain), and its signature grammar can be
richer than CEL's (an optional trailing parameter, a declared JSON Schema per parameter — strictly stronger
than CEL assignability). Judging such a call here leaves the host one move, suppressing the verdict, which
is exactly the after-the-fact classifier this engine exists to retire. **The blind spot is written beside
the tests:** they can show the verdict is withheld and cannot show the host reports it instead, so each
case also asserts the call is **listed** — a verdict withheld and not listed is a verdict lost, and that is
the failure they can see.

**A check can say which schema nodes it read** (`check(source, { schemaDependencies: true })`, the
list on `CheckResult.schemaDependencies`, `schema-dependencies.ts`), so a host that hands over several
versions of one document knows which versions a verdict could tell apart. Each entry is `{ document,
pointer }`: `document` is the very object the host handed over that the pointer is relative to — a
registration's `schema` (or its `document`, for a node a `#…` reference reached), or a resolver answer's
`node` / `root` — so it is matched back by identity, never by content. A node is read **for its own type**
— what its keywords say other than through a subschema with an entry of its own: `type`, `const`, `enum`,
the names in `properties` and whether each is a boolean, the form of `additionalProperties`, `items`,
`prefixItems`, `additionalItems`, `if`, `then` and `else` (absent, `true`, `false` or a schema), how many
positions a tuple and members `allOf` / `anyOf` / `oneOf` hold, whether a `not` schema holds anything
beyond annotations and any value keyword, a `$ref`'s text, and what the host's resolver answers for it;
a `not` subschema read is listed as a node of its own — so two versions agreeing on
the own type of every listed node give the check the same answer. A **descent** (a member, an index, a
comprehension's element) lists the member's node alone, and so a field the expression never reads is
absent; any other **use** of a type (an operand, an argument, a branch, the result) lists everything
beneath it. Conversion records where each type came from (`readSchemaType`'s provenance: per node what
reading it continues into — a reference's target, a crossed document, a union's branches — and per
container the node of each member), and a union branch dropped as equal to another is read whole; an
intersection is read as what its meet compared — each part's own type, the node of each part holding a
position as `dyn`, and where several parts type a position other than `dyn` each of those nodes and the
positions beneath it — so a member one part alone types is listed only when a descent or a use reaches it.
Entries are listed once, in the
order the checker first read them. **Opt-in, because it costs**: unasked, nothing is collected (the
recorder is never built); asked, each type and each reading is walked at most once per check.

**A namespaced function's result may be declared as a JSON Schema document** (`{ name, returns: { schema,
document? } }`), converted through the environment's resolver exactly as a schema-typed variable is: a call
lists the result's root, a read through it lists what it reads, and what the conversion could not judge
is in `schemaReports()` under `<namespace>.<name>`. The provenance is the environment's, beside the
declaration rather than on `NamespaceFunction`, whose fields stay the declaration a host can build. **The
engine answers whether two versions agree on a listed node's own type** (`schemaOwnTypesAgree(left, right,
pointer, { resolveSchemaType?, answersAgree? })`, `schema-own-type.ts`), by the one definition above with
every subschema position masked to its presence and form: a node missing in both agrees, missing in one
does not, and a resolver answer is compared by name and arguments or by the document's identity unless the
host says how. A host never compares keywords itself, so the definition lives in one place.

**A check can name the node each verdict and its result were read from** (`check(source, { schemaNodes:
true })`, `schema-nodes.ts`), so a host words a finding from the node the engine judged, reading only that
node's own type, and compares a forwarded value's node against a slot schema. A `CEL_UNKNOWN_FIELD`, a
`CEL_TYPE_ERROR` and a `CEL_NULLABLE_ACCESS` carry `schemaNode` — the node whose properties lack the
member, the node the first offending operand or argument located at one was read from, the nullable node
dereferenced — absent where its subject is a literal or a computed value, and `{ document, pointer }`
with a dependency's identity. The result carries `resultOrigins`: every place its value may have come
from, in written order, each `{ range, type, typeName, schemaNode? }`. A located read is one origin; a read
over a union whose branches are located at different nodes is one per distinct node, in member order (the
branches located nowhere sharing one); a conditional contributes its branches' origins in turn, each as
its branch was typed; `cel.bind` and `optFlatMap` contribute those of the expression they answer;
`optional.of`, `optional.ofNonZeroValue` and `optMap` are one origin with the wrapping's own type and range;
an origin typed `optional<…>` carries no schema node, since no optional is an instance of one — so a read
through an optional operand (`.?a`, `[?k]`) is one origin over a union too; anything computed is one origin
carrying its type alone.
A host judges a forwarded value over every origin, so keeping one would let a misfitting branch through. **A type is read from
the node that built it**: through a `$ref` or a resolver's document the target, through a union that kept
one branch that branch, a union's members each from the first branch holding it; a node combining parts
(a `type` list, an intersection) built its type itself, and a member of an intersection is read from the
one part declaring it, from none where several do (above). Conversion records that beside every member and
union member, the checker locates each subexpression whose type came straight from a node (a registered
name, a member or element read, a namespaced result, a macro-bound name, an optional wrapping one), and
everything it names — every origin's node included — is also among that check's `schemaDependencies`:
the conformance runners hold every row to it. Opt-in apart from the dependency list, because the two answer different questions; unasked,
nothing is located.

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

**A map's entries are keyed by each key's own typed value** (`CelMapKey`: a string or a bool is itself,
an int, a uint and a whole double are all the `bigint` CEL equality makes them), never by a property name
(`cel-map-value.ts`): that is what lets one container hold CEL's four key types, makes `1` and `1u` one
key as CEL equality requires, and means no key a map holds can reach a prototype. A map is **built** with
an int, uint, bool or string key — a double is not a key type, even a whole one — and still **looks one
up** by any numeric type, because `{1u: 1.0}[?1.0]` reads the entry.

**The types separate themselves, which is why nothing is prefixed.** A `Map` compares a key by type as
well as by value, so a string `"1"` and an int `1` are distinct keys and `"true"` is not `true` with no
`s`/`n`/`b` namespace built per key. The prefix those three guarantees used to rest on was **46% of a
map literal's build cost and was paid again on every lookup** — measured, against a prototype-free plain
object for the entries, which turned out *slower* than the `Map` (five hidden-class transitions beat five
`Map.set` the wrong way) and against the entry wrapper, which costs nothing. So the text was the
mechanism and never the contract; a port keys an entry by its own discriminant instead of reproducing
this engine's strings byte for byte. The rule is **not exported** — what identifies an entry is the
entries map's own business, and publishing it is what let the SDK's typed frame grow a second copy of it;
a host reads a map through the member-read seam and walks `entries` for the pairs.

**The entries arrive flat** — key, value, key, value — so a literal of n entries costs one allocation
rather than one per entry, and a duplicate is caught by the size not moving rather than by a probe per
key. **The flat shape is type-compatible with the pairs shape it replaced** (an array of two-element
arrays IS a `readonly CelValue[]`, because a list is a `CelValue`), so the compiler cannot catch a caller
that was not converted — the conformance decoder was exactly that caller, and the replay is what found
it. A new caller is checked by running the replay, never by the types.

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
registration over a type that is not constructible still wins, having resolved first).

**There is ONE comparison, and across the numeric types it CONVERTS** (`value-equality.ts`). It serves
`<`, `<=`, `>`, `>=`, cross-numeric equality and `in` over a list; a list index reads the element its
index names through the same rule. Where the double lies outside the integer type's range the sign
decides; otherwise the integer becomes a double and two doubles are compared — **lossily**, so
`dyn(9223372036854775807) < 9223372036854775808.0` is `false`. That is cel-spec's rule, named and
commented in its own corpus, and `int(double)` refuses a double at or beyond **either** int64 extreme for
the same reason. An exact comparison would be defensible alone and indefensible as a cross-engine
contract: a second engine on a conformant library would answer the other way on a comparison that can
decide an authorization or a retry bound. **A map's key identity is not this comparison** and does not
convert: a map is keyed by its key's own typed value, so `{1u: 1.0}[?1.0]` reads the entry while `[?3.1]`
is `unsupported_key_type` — a double that is not whole is a mistake in the READ, since no key of any type
could have been the one asked for, rather than an entry that is absent.

**The duration GRAMMAR and the duration RANGE are separate questions, and both are exported.**
`parseDuration` is CEL's text under CEL's range; `durationNanosFromText` is the same grammar with
**no range applied**, answering an unbounded `bigint`. A consumer outside CEL has the same grammar
with a different range — protobuf's `google.protobuf.Duration` reaches ±10,000 years, which cannot be
held in an int64 of nanoseconds at all — so a reader that must carry one (a journal entry, a value off
a transport, the `cel-duration` plain encoding) would otherwise restate this grammar. It does not: it
takes the total and applies its own bound. `celDurationFromNanos` is what applies CEL's. The units are `ns`, `us`, `µs`, `μs`, `ms`, `s`, `m`, `h`, `d` (24 hours) and `w` (7 days); `d` and `w` extend cel-spec on purpose, months and years having no fixed length. Output stays seconds (`86400s`).

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

**A dispatch is decided by the VALUES, at one site, from the registry** — never by a declared type, never
by the emitter, and never by a table of operator behaviour beside the runtime library. The rule has teeth
because the alternative was measured and is faster: a `typeof`-keyed fast table of operator
implementations is 1.68× cel-js on a guard-and-concatenate expression where the decided shape is 1.30×.
It is refused anyway, and **by execution rather than by argument**: such a table is global, so it sits
outside the environment digest, and on a hit it consults no registry — a host that registers its own
case-insensitive `==` over two strings gets the standard library's answer back, on every call, cold and
warm, while the site as it is answers the host's. A replaceable standard library is what this package
exists for, so a fast path that silently discards a registration is not a trade.

**An implementation takes its call context first and its arguments positionally** (`CelImplementation`),
up to `CALL_SITE_DIRECT_ARITY` — the widest arity any registration declares. So a call allocates nothing:
both backends pick the entry point (`call0` … `call4`) from the arity they have, through the same rule,
and the guard is a field compare per argument rather than a loop over an array. Context-first is
load-bearing rather than cosmetic: an implementation shared across two arities of one name (`substring`,
`indexOf`, `join`) would otherwise have the context land in a shifting position, and no CEL value is
`undefined`, so an absent trailing argument is unambiguous. In a port the same contract is a context plus
a slice, which allocates nothing either.

**The bound is declared, so it is also enforced.** A signature wider than it is refused where it is
registered (`signature_too_wide`), because an implementation could otherwise only be called with its tail
dropped — a declared bound nothing checks is the silent wrong answer it exists to prevent. **But the
arity of a CALL is the SOURCE's, not the dispatch key's**: anyone may write a call of any width, and
`'42'.replace('2', '1', 1, false)` — five values — is a conformance row. A call past the bound takes the
array form and answers the ordinary `no_matching_overload` naming the types it was handed. Assuming the
dispatch key fixed a call's arity crashed the emitted module on that row, which the replay caught.

**A registration's implementation is the host's half.** The engine's own implementations are looked up by
dispatch key, so a registration carries one only where the host supplies it; a call that resolves to a
registration with neither answers `unbound_function` — `unbound function '<name>' — <signature> is declared and
nothing implements it`, ranged over the call and decided after its arguments, whose types chose the overload —
never `no_matching_overload`, which says no registration takes those types and would be false here.

**A value that must be awaited is refused at every door it comes through, and the doors are a NAMED
list** — one refusal (`asyncValueRefused`, `cel-value.ts`), so no door answers with a different code or
wording:

1. an **activation read**;
2. a **registered implementation's result**, a construction builder's included;
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
every function signature surviving registration and removal, every named type with its base,
parameters, fields and construction, every variable with its type, every namespace with its functions, every option
value, sorted.
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
host supplies (`EmittedModuleStore`) and **touches no filesystem**. The same seam may supply `digest`, the host's SHA-256 of a text's UTF-8 bytes,
used for the module body on both the emit and the verify path in place of this package's pure-JS one, which is
slow on a large body under some runtimes (about 220 ms for a 760 KB body under Bun). It must answer exactly what
the built-in digest answers; the key and the environment digest stay on the built-in one. It exports no loader, because a loader
would have to reach a filesystem (which this package may not), be `eval` (which the closure backend exists
to avoid), or be a `data:` URL import (fine under Node, refused under a browser's content security
policy). Nothing under `cel/nodejs` names a path outside it, the cache root included: a host anchors that.

**No bare property access implements a CEL read**, and the gate for it is over the whole emitted text
rather than over the names of a probe: every property the emitted code reads must be one of the
structural fields (`activation`, `namespaceFunction`, `present`, `held`, `push`, `call` and its `call0` … `call4` entry points, and a construction site's `build`), so a CEL field
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
analyzer's surface generation and the language-server's engine identity). Its value is the recorded
version of the analyzer unit — `V+unreleased` in every build, and exactly `V` only in a package's `prepack` —
read with no release plan, so a dev build never assembles one. A content digest over the engine's own
declared surface was the other candidate and is blind in exactly the direction this field exists to look:
that same temporaries defect leaves such a digest byte-identical, and a Rust engine sharing a cache root
would have to reproduce it byte for byte, where the line's version is a number both halves already carry.

## `matches` is RE2

CEL's pattern language is RE2 (`regular-expression.ts`, over `re2js` pinned exactly, as templating pins
it): linear-time matching, no backreferences, no lookaround. The host's own engine accepts patterns RE2
refuses and is exponential on some of them, so an expression that matched here would behave differently
on another runtime and a hostile pattern in a manifest would be a denial of service. A pattern RE2 cannot
parse is `invalid_regular_expression`, never a silent `false`. It is the package's **one runtime
dependency**, and it costs the browser bundle about 420 KB.

## The conformance replay

The vectors are the cross-engine contract, and this package drives the files a Node engine alone answers (`CEL_CONFORMANCE_DIR`, below): `language.json` whole, and `catalog.json` / `types.json` through a projection. Three drivers live in `conformance/`, and each states its blind spot in its header. There is no list of rows answered otherwise anywhere: a row is the engine's answer, or the run fails.

**`language.json`: one table-free whole-row driver** (`conformance/language-replay.ts`). `languageAnswer` computes the whole `expect` of a row — the check half in the environment with the row's types, declarations and functions (`diagnostics` with ranges, `type` only when clean, every call the checker lowered, resolved or not), the evaluation half in the environment with the types and functions alone, which checks first and records a refusal as the first diagnostic's `CEL_*` code with its range, and otherwise evaluates with the bindings — and the driver deep-compares it with the row. Beside it: the row-key gates (`divergence` refused by name), the two classes (the cel-spec import, then authored `telo/` rows with neither `provenance` nor `deviation`), the `celCode` membership check (`conformance-error.ts` holds the vocabulary, the engine-error codes held complete by their type; no new export from this package), the `deviation` checks above, and the round trip of every source that reads — it writes back and reads again to an equal tree. `LANGUAGE_ROWS` pins the count (2,189). A row's `types` — type definitions as data, in registration order, with no builder — are registered before its declarations and functions in both halves. The error classifier reads the error that left the seam: an evaluation error or an engine error gives `celCode`, an `ERR_*` gives `code`, no code gives both null — which in `language.json` is the engine failing, never an answer, and fails the row — and any other code fails the row naming it.

**`catalog.json` and `types.json`: the table-free projection driver** (`conformance/dialect-replay.ts`). These files hold the `cel` tag engine's whole answer, which the templating package's test reproduces; this driver computes the part this engine gives by itself — the projection: the check's diagnostics (`code`, `message`, `fix`, in order, no range) and its type when clean, then the row's value or its error (`code`, `celCode`, `message`) — and deep-compares it with the same projection of the row. Before that a row is held to the **input gate**: the tag `cel`, no `context`, `explain`, `rootsDeclared`, `couldNameModule`, `modules` or `functions`, a source that reads, and only the engine's own errors (`code: null`, a `celCode`). Its static half checks in the dialect environment plus the host's types plus the row's declarations; its runtime half evaluates unchecked in the dialect environment plus the host's types, **without** the declarations, with the bindings — so a row can record a refusal at check and a value at evaluation (`p + 1` over a port). Every conversion and member a host type declares is bound at runtime to a conformance implementation answering `<name>(<conformance text of each argument>)`, the handler set's rule, and the nine host-backed functions answer by the handler set. `CATALOG_ROWS` (195) and `TYPES_ROWS` (75) pin the counts. **Its blind spot:** it sees nothing outside the projection — calls, regions, refs, volatility, a site's context — which only the templating test holds, and its deep equality pins whatever this engine answered.

**The host's vocabulary is a PARAMETER, never a name written here.** The driver takes `NominalTypeDefinition`s (`CEL_CONFORMANCE_HOST_TYPES`), which `scripts/check-cel-conformance.mjs` derives from `sdk/value-types/*.json` by rule and naming no type: a `json` entry with no `celType` is a brand over its `base` (its base conversion and `string(Self)`); `fromHost` adds `Self.joinPath(string): Self`; `members` become fields plus `string(Self)`; and `Stream` over `dyn`. The driver fails naming any type a row declares that the list does not carry, which is what lets the gate be driven by the host's rows while the package stays free of a host type name.

**One canonical encoding, written and read** (`conformance/conformance-value.ts`): a timestamp is the typed frame's trimmed form, `readCanonicalConformanceValue` refuses any node that is not the canonical encoding of the value it reads, and nothing accepts a second spelling.

**The `celCode` gate is not here.** It counts codes across all six files and lives in the templating package's test, which reads `language.json` for it. It counts codes, not functions: a catalog function whose refusal no row pins can hide behind another function's row, and the coverage gates over overloads and guards are what pair a function to a row.

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
driver reported **0 disagreements** over all the rows then in the file (1,814) with that bug in place; the case list caught it on
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

(Items 1, 2, 4, 9 and 10 name the check-level and value-level drivers and their exclusion lists, since merged
into one whole-row driver with no list; they stay as the reasons it compares whole answers.)

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
    is true of the row — nine rows the engine checks clean were counted as excused;
11. a cold-against-warm gate over a site's two dispatch paths, built from cases that **do not
    discriminate**: `size` over a three-character string and over three bytes both answer `3n`, through
    different overloads, so deleting the guard's type comparison altogether left it green. Its cases now
    assert that their own types answer differently before they are allowed to prove anything;
12. and the same gate comparing a program against **itself**: a compile from text is memoized, so the
    "fresh site" it held each answer to was the very site it had just warmed. Both controls passed for
    that reason alone. A fresh site is compiled from a parsed tree, which is deliberately not keyed on.
13. **a value-domain change gated only by the suites of the package that MADE it.** The map
    representation moved from a host `Map` to a `CelMap`, and this package's 310 tests, its 39
    conformance rows and both backend-identity gates were green throughout — because every one of
    them asks what the ENGINE answers, and the engine was right. What broke was every host reader
    of a map outside it: the plain-JSON writer and the typed frame still recognised `Map`, so a
    journal could not record a map and an HTTP body wrote `{"entries":{}}`; the arguments of a
    module function and of `json()` crossed out unconverted; a log attribute, the debug wire and
    four controllers read a class the domain no longer has. Thirteen manifest tests found them,
    one symptom at a time. The filter is the package boundary, and nothing inside it can reach
    past it: what covers the class is that a representation change enumerates its readers — the
    engine exports the predicate (`isCelMap`) and the builder (`celMapFromEntries`) so there is
    one way to ask and one way to make, and `grep` for the representation it replaced is the sweep.
14. a **dialect replay whose row count nothing pinned**: every number it printed was derived from the
    rows it read, so deleting a row left the report self-consistent and true. A per-row driver sees a row
    that disagrees and cannot see a row that is gone — the vectors' whole purpose is to adjudicate a
    question the NEXT time it is asked, and a row nobody misses adjudicates nothing. `CATALOG_ROWS` and
    `TYPES_ROWS` are the pin; its own blind spot is that a row can still be rewritten in place, which is
    a fixture diff a reviewer sees.

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
- The count of the types the whole-type walks visit, which the cost gates read → `src/type-visits.ts`
- How a type is printed and where it is cut → `formatType` / `exactTypeText` in `src/cel-type.ts`, the limit as data → `src/type-text.json`
- Types, their spelling, assignability and unification → `src/cel-type.ts`, `src/type-expression.ts`
  (an unregistered NAME in a readable expression is `CelUnknownTypeNameError`, a verdict for a caller
  that holds its source, never a refusal to register)
- A schema or a field map as a type → `src/json-schema-type.ts`
- How a record reads a member a literal names (fields, patterns, undeclared members, absence) → `src/record-member.ts`
- Whether two versions agree on a node's own type → `src/schema-own-type.ts`
- Which schema nodes a check read → `src/schema-dependencies.ts` (the recorder and the reading),
  `readSchemaType` in `src/json-schema-type.ts` (where each type came from), `typeOf` / `typeOfOperand`
  in `src/checker.ts` (a use against a descent)
- Which node a verdict or a result was read from → `src/schema-nodes.ts` (the locator), the `node` of
  each read in `src/json-schema-type.ts`
- A host's own named type → `src/nominal-type.ts`, and `registerType` in `src/environment.ts`; its
  fields read at check → `fieldType` in `src/checker.ts`, at evaluation → `celLookup` in
  `src/member-read.ts` with `memberReadsOf` in `src/backend-runtime.ts`
- A construction `Name{…}`: what its name resolves to and every refusal → `src/construction.ts`;
  checked → `structType` in `src/checker.ts`; built → `ConstructionSite` in `src/backend-runtime.ts`;
  compared → `celEqual` in `src/value-equality.ts`, and an `==` / `!=` registration refused over one →
  `comparedConstructible` in `src/construction.ts`
- Registration, override, removal and overload resolution → `src/function-registry.ts`, `src/signature.ts`,
  the union expansion limit as data → `src/union-expansion.json`
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
- Which forms bind a value into a body → `src/comprehension-bindings.ts` (`BINDING_FORMS`,
  `receiverMacroBinding`, `namespaceMacroBinding` — exported, because a host walking a tree needs the
  engine's own enumeration rather than a list of comprehension method names kept in step with it)
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
- Whether a site answers the same cold as warm — its resolving path against its monomorphic one, which
  no backend-identity gate compares because both backends run the same site →
  `tests/call-site-identity.test.ts`
- What identifies a map's entry, across a literal, a comprehension and `parseJson` →
  `tests/map-key-identity.test.ts`
- Whether the emitter writes the text it wrote before → `tests/emitter-text.test.ts`, over
  `tests/emitter-text-corpus.ts`, pinned in `tests/__fixtures__/emitter-text.json`
- A bounded cache → `src/bounded-cache.ts`
- Whether the whole package type-checks — `src`, `tests` and `conformance` → `check:types`
- The conformance drivers → `conformance/language-replay.ts` (`language.json`, whole),
  `conformance/dialect-replay.ts` (`catalog.json` and `types.json`, through the projection, over a
  host's types), `conformance/emitter-identity.ts` (the two backends), with the error classifier in
  `conformance/conformance-error.ts` and the row encoding in `conformance/conformance-value.ts`
