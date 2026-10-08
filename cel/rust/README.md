# telorun-cel

The CEL language for Rust: the Rust half of `@telorun/cel` (`cel/nodejs`). Today it is the engine's **front end**: it reads CEL source into the ranged syntax tree, with the input limits and error recovery; resolves namespace-qualified calls; writes a tree back as source; and answers the two questions a consumer asks of a tree — what it reads, and which namespaced functions it calls. It answers as the Node front end answers: the same tree, the same diagnostic code, message and range, the same written text, the same refusals and the same query results, for every source.

It stands on `telorun-cel-value` (`cel/rust/value`), the value domain, and takes its `SourceRange` from there.

## Rules

- **One dependency.** `[dependencies]` is exactly `telorun-cel-value`, by path, and no registry crate. `cargo tree -p telorun-cel -e normal` prints two lines. The one dev-dependency is `serde_json`, pinned to the version the workspace lock already holds; it reads the conformance vectors in one test and reaches nothing under `src/`.
- **No host vocabulary.** No kind, annotation, tag or manifest word appears in `src/`, and `src/` reads nothing outside this directory. The crate owns CEL and nothing above it.
- **No recursion on input.** No function recurses in proportion to a source or a tree. See *Depth* below.
- The crate is `publish = false`, licensed MIT, and carries `@telorun/cel`'s version: the two are one artifact in two languages, stamped together by the version step.

## What it does, and what it does not yet

**Supported: reading.** `parse_syntax(source: &str, options: &ParseOptions) -> ParseResult` reads one expression and never fails; the defaults are written `&ParseOptions::default()`. It answers a `ParseResult`: the `source` (an `Arc<str>`, the text copied once when it is read and shared by every later holder), the `root` of the tree (an `Arc<CelNode>`), and `diagnostic`, an `Option<CelSyntaxDiagnostic>` — the first thing that could not be read, held exactly when the whole source could not be read. Node answers a `diagnostics` list of at most one entry; here that is the `Option`. The tree is always there: it keeps what was understood, with an `Unparsed` node where the rest would have been.

- `ParseOptions { limits, optional_syntax }`. `optional_syntax` turns on `[?x]` and `{?k: v}`; off, the question mark is a misplaced token. `ParseOptions::default()` is Node's defaults.
- `CelParseLimits` holds the five limits — `max_nodes` (100000), `max_depth` (250), `max_list_elements` (1000), `max_map_entries` (1000), `max_call_arguments` (32). Its `Default` is `DEFAULT_PARSE_LIMITS`, and a partial override is a struct update. A limit reached is a `limit_exceeded` diagnostic like any other, so the prefix is kept.
- `CelSyntaxCode` is the closed set of Node's sixteen codes, written by `as_str()` (`unexpected_token`, `unterminated_string`, `limit_exceeded`, …). A code is never derived from a message.
- The words: `RESERVED_WORDS` (cel-spec's 21), `LITERAL_WORDS`, `OPERATOR_WORDS`, `is_reserved_word`, `is_identifier_spelling`. A reserved word is refused as an identifier and accepted as a member name.

**Supported: the namespace pass.** `Alias.fn(x)` and `obj.method(x)` are one syntax, so only a set of names that denote namespaces can tell them apart, and the reader has no such set.

- `normalize_namespaces(names) -> Result<Vec<String>, CelNamespaceError>` validates a set and puts it in canonical order: sorted, each name once. A name that is not spelled as an identifier, is a reserved word, or is `cel` or `optional` (`RESERVED_NAMESPACES` — the standard macros are written on them) is refused. `namespace_sets_equal` compares position by position, so it is a set comparison only when both sides are normalized.
- `resolve_namespaces(root: &Arc<CelNode>, namespaces) -> Arc<CelNode>` rewrites every call on a bare, non-absolute name of the set into a `QualifiedCall`, wherever it stands. It is the only producer of that kind. What it does not rewrite it shares: an unchanged subtree is the same `Arc`, and a tree nothing moved in — or any tree under an empty set — is the root it was given. Its answer depends on membership alone: the order of the names and a name given twice change nothing. It does not validate the names, so a set that did not come from `normalize_namespaces` may hold `cel` or `optional` and capture the standard macros; `parse_expression` is the path that always validates.

**Supported: an expression, read and resolved.** `parse_expression(source: &str, options: &ParseExpressionOptions) -> Result<CelExpression, CelNamespaceError>` is the front end's whole answer, and the pass always runs.

- `ParseExpressionOptions { parse, namespaces }` holds the reader's `ParseOptions` whole — handed to `parse_syntax` unchanged — and the namespace names. `ParseExpressionOptions::default()` is Node's defaults: no namespace.
- `CelExpression { source, root, namespaces, diagnostic }`: the reader's `source`, the resolved `root`, the set the tree was resolved under in canonical order, and the reader's `diagnostic`. All but the diagnostic are shared (`Arc<str>`, `Arc<CelNode>`, `Arc<[String]>`), so a clone copies no text and no tree. As for `ParseResult`, Node's `diagnostics` list of at most one entry is the `Option`.
- `resolved_under(&expression, names) -> Result<bool, CelNamespaceError>` says whether the expression was resolved under exactly that set.
- The only `Err` is a namespace set no host can have. A source that cannot be read is still an `Ok` holding its diagnostic.

**Supported: writing a tree back.** `serialize_tree(root: &CelNode) -> Result<String, CelSerializeError>` answers Node's text for every tree Node writes.

- **The contract is a round trip under the options the tree was read with.** The text written for a tree that read with no diagnostic reads back to an equal tree (`trees_equal`) when it is read with the same options: an optional entry (`[?x]`, `{?k: v}`) is written wherever the tree holds one and reads back only with `optional_syntax` on, and a qualified call is written as `Alias.fn(x)` and reads back as one only under its namespace. The one exception is the negated chain on a number named under *Interim readings*. The writer takes no options, so it cannot know either.
- Parentheses come from precedence alone, a string is always between double quotes, a bytes literal is always `b"…"`, a member name that is not spelled as an identifier is between backticks, and a double is written as ECMAScript writes a number — `1e+21`, `0.000001`, `100.0` — with `1e999` and `-1e999` for the infinities.
- It refuses what has no source: an `Unparsed` hole, a double that is not a number, a name, function name or namespace that is not a name, and a member name holding a backtick or a line feed, or empty. A tree with several such faults reports the first in the order the text is written, as Node does.

**Supported: the two tree queries.**

- `qualified_calls(root) -> Vec<QualifiedCall>`: every call on a namespace, a call before any call written inside it, each with its namespace, name, `qualified_name`, arity and ranges. Only a resolved tree holds one, so the answer is relative to the set the tree was resolved under.
- `root_references(root) -> Vec<String>`: the first name of every access chain, sorted, each once. A name a comprehension or `cel.bind` binds is not one inside the arguments the binding reaches; the namespace of a qualified call is not one; and neither is `cel` or `optional` as the receiver of a call.
- The binding forms are data, shared with whatever lowers them later: `BINDING_FORMS`, `receiver_macro_binding(name, arity)` and `namespace_macro_binding(namespace, name, arity)`, each answering a `ComprehensionBinding` — the argument that is the bound name, and the arguments evaluated with it in scope. An arity the table does not list binds nothing.

**Two error types.** `CelNamespaceError` and `CelSerializeError` are plain `std::error::Error` structs carrying Node's `message`, a quoted name written as `JSON.stringify` writes it. Neither has a code: Node's have none. Where Node throws one, the function here answers it as an `Err`.

**Not supported yet:** types, checking, evaluation and the function catalog. Each arrives with its own files — see the table.

## Files

Each file twins the `cel/nodejs/src` file of its name; `lib.rs` twins `index.ts`. Every public item is exported at the crate root, and the exports are the front-end block of Node's entry plus its comprehension-binding table, less the items listed as having no twin and `declared-chain.ts`, which arrives with the checker.

| File | Twins | Public items | Node items with no twin |
|---|---|---|---|
| `reserved_words.rs` | `reserved-words.ts` | `RESERVED_WORDS`, `LITERAL_WORDS`, `OPERATOR_WORDS`, `is_reserved_word`, `is_identifier_spelling` | — (the word reading is private, as on Node's entry) |
| `syntax_diagnostic.rs` | `syntax-diagnostic.ts` | `CelSyntaxCode`, `CelSyntaxDiagnostic` | — (the first-diagnostic holder is private, as on Node's entry) |
| `parse_limits.rs` | `parse-limits.ts` | `CelParseLimits`, `DEFAULT_PARSE_LIMITS` | `resolveParseLimits` — the limits are one struct with a `Default` |
| `syntax_tree.rs` | `syntax-tree.ts` | `CelNode`, one struct per kind, `CelListElement`, `CelMapEntry`, `CelLiteral`, `CelUnaryOperator`, `CelBinaryOperator`, `SourceRange`, `child_nodes`, `walk_tree` (`TreeWalk`), `has_unparsed` | — |
| `tree_equality.rs` | `tree-equality.ts` | `trees_equal` | — |
| `lexer.rs` | `lexer.ts` | none (the tokenizer and its token are private, as on Node's entry) | `MAX_INT`, `MIN_INT`, `MAX_UINT` — the range is the type; the chunked code-unit-to-text helper; every raw-lone-surrogate path |
| `parser.rs` | `parser.ts` | `parse_syntax`, `ParseOptions`, `ParseResult` | `ParseResult.diagnostics`, a list of at most one — it is `diagnostic`, an `Option` |
| `namespace_resolution.rs` | `namespace-resolution.ts` | `RESERVED_NAMESPACES`, `CelNamespaceError`, `normalize_namespaces`, `namespace_sets_equal`, `resolve_namespaces` | — (the error is an `Err`, where Node throws it) |
| `cel_expression.rs` | `cel-expression.ts` | `CelExpression`, `ParseExpressionOptions`, `parse_expression`, `resolved_under` | `CelExpression.diagnostics`, a list of at most one — it is `diagnostic`, an `Option` |
| `serializer.rs` | `serializer.ts` | `CelSerializeError`, `serialize_tree` | the two integer-range refusals — a literal holds an `i64` or a `u64`, so the range is the type |
| `comprehension_bindings.rs` | `comprehension-bindings.ts` | `ComprehensionBinding`, `BINDING_FORMS`, `receiver_macro_binding`, `namespace_macro_binding` | — |
| `qualified_calls.rs` | `qualified-calls.ts` | `QualifiedCall`, `qualified_calls` | — |
| `root_references.rs` | `root-references.ts` | `root_references` | — |

Node files not twinned yet, by what brings them:

- **Types and the checker:** `cel-type.ts`, `type-expression.ts`, `json-schema-type.ts`, `nominal-type.ts`, `signature.ts`, `function-registry.ts`, `standard-library.ts`, `environment.ts`, `checker.ts`, `check-diagnostic.ts`, `macro-shape.ts`, `macro-check.ts`, `nullable-access.ts`, `declared-chain.ts`, `resolved-call.ts`.
- **Evaluation:** `activation.ts`, `member-read.ts`, `value-equality.ts`, `integer-arithmetic.ts`, `runtime-library.ts`, `comprehension-runtime.ts`, `regular-expression.ts`, `backend-runtime.ts`, `closure-backend.ts`, `cel-program.ts`, `bounded-cache.ts`, the engine halves of `cel-value.ts` and `timestamp-value.ts`, and the emitter's files.
- **The catalog:** `function-catalog.ts`, `catalog-runtime.ts`, `zoned-calendar.ts`, `json-text-scan.ts`.

## The tree

`CelNode` is an enum of thirteen kinds, each holding its own public struct with Node's fields: `Literal`, `Ident`, `List`, `Map`, `Select`, `Index`, `Call`, `ReceiverCall`, `QualifiedCall`, `Unary`, `Binary`, `Conditional`, `Unparsed`. Every node has a `range`, read from any kind with `CelNode::range()`.

- **Shared and immutable.** A single child is an `Arc<CelNode>`; a list of children is a `Vec` of them; list elements and map entries are small structs (`CelListElement`, `CelMapEntry`). `Clone` is shallow. A node is `Send + Sync`.
- **Literals are the tree's own.** `CelLiteral` is `Int(i64)`, `Uint(u64)`, `Double(f64)`, `String`, `Bytes`, `Bool` or `Null` — `1` and `1u` are different expressions. A `-` written directly on an int or a double literal is part of the literal, which is how the int64 minimum and `-0.0` are written.
- **Macros stay calls.** `has(x)`, `xs.map(i, i)` and `cel.bind(…)` are ordinary call nodes.
- **`Drop` is hand-written**, so a field cannot be moved out of an owned `CelNode` (E0509). Match by reference, or clone the `Arc`.

Traversal is `child_nodes` (every child, in source order), `walk_tree` (depth-first, pre-order) and `has_unparsed`.

### Two equalities

- **`trees_equal(a, b)`** — whether two trees are the same expression. It ignores every range and whether a member was written between backticks; any `Unparsed` equals any `Unparsed`; an absolute name is not the plain one. It is Node's `treesEqual`.
- **`==` on a node** — whether two trees are the same data: every field, every range and `quoted` included. It is what a test compares a read tree to a literal one with. Nodes are deliberately neither `Eq` nor `Hash`.

Both compare a double as itself: NaN equals NaN, and `-0.0` is not `0.0`.

## Depth

Stack use is constant. The parser holds its pending grammar positions on the heap rather than in call frames, and walking, the hole test, both equalities, the namespace pass, the writer, both queries, `Debug` and `Drop` each run on a heap work list. So:

- `max_depth` bounds **heap, not stack**. It is still Node's limit, counted as Node counts it and refused with the same diagnostic at the same place; raising it costs memory only.
- A chain is not nesting. `1+1+…` and `a.b.c…` read up to the node limit as left-deep trees fifty or a hundred thousand deep, and a hand-built tree has no bound at all. Each is walked, compared, resolved, written back, queried and released like any other — where Node's own walkers, its pass, its writer and its queries throw `RangeError`.
- Release is iterative and shares nothing. Dropping a tree unlinks the descendants it alone owns onto a heap list; beyond that list it makes at most one allocation per release — a placeholder leaf, only when a nested single child has to be taken out of its field — and touches no state another release can see, so trees released on many threads do not contend.

## Positions

A range is a half-open `[start, end)` span of **UTF-16 code units**, as Node's is, whatever the source's UTF-8 width: `'😀'` is four units. The reader counts bytes and units together as it goes, with no position table.

Ranges are Node's arithmetic, unclamped. An escape is ranged by its nominal width, so `"\x` reports `[1, 5)` in a source of three units; and a character outside the basic plane is reported as its first code unit alone.

## Where it differs from Node

Each difference exists because a `&str` cannot hold half a character or because a range is two `u32`s.

- **One message.** An escape before a character outside the basic plane (`"\😀"`) is `\😀 is not an escape sequence`. Node's message holds an unpaired surrogate there. The code and the range are Node's.
- **A source too long to range.** A source of more than 4,294,967,285 UTF-16 code units (`u32::MAX` less the width of the widest escape) is refused whole: `limit_exceeded`, `the expression has more UTF-16 code units than the limit of 4294967285`, range `[0, 0)`, and an `Unparsed` root. Node cannot hold such a source.
- **Raw lone surrogates.** Node reads a lone surrogate written raw in a string or bytes literal. No `&str` holds one, so no such source reaches this crate.
- **Trees Node's walkers cannot finish** are handled here — see *Depth*.

## Numbers

- An integer's magnitude is accumulated in 64 bits with an overflow flag, in either radix, so leading zeros never overflow and no digit count is a limit. A refusal prints the literal as written.
- A double is read by the standard library's correctly rounded parse of the literal's digits, which is what `Number(digits)` answers on Node, bit for bit — including overflow to infinity and underflow to zero. ECMAScript permits an engine less than that past twenty significant digits; the rule here is the correctly rounded one.

## Interim readings

Node reads some sources in ways its own documentation does not intend. This crate reproduces each until Node changes, because two engines reading one source differently would make two kernels disagree about one manifest. `tests/interim_readings.rs` names every one:

- A lexer error anywhere beats an earlier parser error, and the tree is what the parser builds already stopped: `1 + 2 + 'abc` is the tree `1`, `f(1, 'abc` is `f` with no arguments, `[1, 'abc` is an empty list.
- `.true`, `.false` and `.null` read as absolute names.
- An empty quoted member (``a.`` ``) reads clean, as a select with an empty field and `quoted: true`.
- Both of those read clean and cannot be written back: the writer refuses the name `true`, and a member name that is empty.
- An optional entry is written wherever a tree holds one, so the text of a tree read with the optional syntax on does not read with it off.
- A negation of a member, index or call chain that starts at a non-negative number literal is written without the parentheses that keep it one: `-(1).a` is written `-1.a`, which reads back as a member of `-1`.
- A raw single-line literal continues across a backslash followed by a line feed, and a backslash that ends the source is content.
- A single-line literal holds a raw carriage return.
- A character outside the basic plane where no token can stand is reported as its leading surrogate over one code unit.
- A range may end past the end of the source.

## Tests

Six files are twins of a `cel/nodejs/tests` file, case for case: `lexer.rs`, `parser.rs`, `namespace_resolution.rs`, `serializer.rs`, `qualified_calls.rs` and `root_references.rs`. One Node assertion has no twin: the writer's refusal of a hand-built int literal of 2^63, which no tree here can hold.

Past the twins, for what Node's tests leave unasserted: `syntax_diagnostic.rs` (every code and message template), `interim_readings.rs`, `double_literal.rs` (bit patterns of the hard decimal cases), `syntax_tree.rs` (traversal and the two equalities), `reserved_words.rs`, and `deep_tree.rs`, which runs wholly on a 256 KiB stack. The four twins of the pass, the writer and the queries also go past their Node files, each saying so in its header: the message of every refusal, the text of every literal and name form, where parentheses go, which fault a tree with several reports, and the binding table. `tests/support/mod.rs` builds literal trees and holds a source, an expression or a tree to a recorded answer.

**Every expected tree, code, message, range, bit pattern, boundary number, written text, refusal and query answer was produced by executing the Node build**, not by reading it. The procedure: the Node build's `parseSyntax` is run on the same sources under the same options, and what it answers is recorded — the tree with every range, and the diagnostic's code, message and range; for the traversal and equality tables, what `walkTree`, `childNodes`, `hasUnparsed` and `treesEqual` answer. For the pass, the writer and the queries it is the same: `parseExpression` and `resolveNamespaces` are run under the same namespace set and options and the resolved tree, the recorded set and the identity of what is shared are recorded; `normalizeNamespaces`, `namespaceSetsEqual` and `resolvedUnder` for their answer or the message they throw; `serializeTree` on the same tree — read from a source, or built by hand field for field — for its text or the message it throws; `qualifiedCalls`, `rootReferences` and the binding lookups for what they answer. Each file's header names the package version and the commit it was run at. The exceptions are this crate's own answers, each named where it is asserted: the two differences above, `==` on a node, the `Debug` text, pointer identity where Node asserts `toBe`, an `Err` where Node throws, and the properties Node cannot answer because its walkers throw — that a deep tree is handled at all, every read under raised limits, and what the pass, the writer and the queries answer on a tree of full length.

### The conformance vectors

`tests/conformance_round_trip.rs` reads `templating/cel-conformance/` in place — the one test that reads outside this directory — and fails when a file is missing. It selects every row of `language.json`, `catalog.json` and `types.json` and every row tagged `cel` of `holes.json`, `module-calls.json` and `verdicts.json`; a row tagged `interpolate` or `sql` holds text with holes, not an expression. It reads only a row's `id`, `source`, `tag` and `modules.names`, never what the row expects.

Each selected source is read with `parse_expression`, the optional syntax on, under the row's module names. A source that reads must hold no hole, write, read back under the same options with no diagnostic, and be the same expression. Pinned from the Node build run on the same selection: each file's row, selected and excluded counts; the exact set of ids that do not read, each with its syntax code; and that the number of `language.json` rows that round-trip is the one Node's own replay of that file reports.

What it does not see: a source both engines read to different trees that each round-trip. The twins, the diagnostic tables and the interim readings hold that class until the vector runners compare the engines' answers row by row.

Semantics shared with the Node engine, and the reasons behind them, are in `cel/nodejs/CLAUDE.md` ("The front end", "The grammar is cel-spec's", "The reserved set").
