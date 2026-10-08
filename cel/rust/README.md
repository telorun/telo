# telorun-cel

The CEL language for Rust: the Rust half of `@telorun/cel` (`cel/nodejs`). Today it is the engine's **reader** — CEL source into the ranged syntax tree, with the input limits and error recovery — and it answers as the Node reader answers: the same tree, and the same diagnostic code, message and range, for every source.

It stands on `telorun-cel-value` (`cel/rust/value`), the value domain, and takes its `SourceRange` from there.

## Rules

- **One dependency.** `[dependencies]` is exactly `telorun-cel-value`, by path. No registry crate and no dev-dependency. `cargo tree -p telorun-cel -e normal` prints two lines.
- **No host vocabulary.** No kind, annotation, tag or manifest word appears in `src/`, and `src/` reads nothing outside this directory. The crate owns CEL and nothing above it.
- **No recursion on input.** No function recurses in proportion to a source or a tree. See *Depth* below.
- The crate is `publish = false`, licensed MIT, and carries `@telorun/cel`'s version: the two are one artifact in two languages, stamped together by the version step.

## What it does, and what it does not yet

**Supported: reading.** `parse_syntax(source: &str, options: &ParseOptions) -> ParseResult` reads one expression and never fails; the defaults are written `&ParseOptions::default()`. It answers a `ParseResult`: the `source` (an `Arc<str>`, the text copied once when it is read and shared by every later holder), the `root` of the tree (an `Arc<CelNode>`), and `diagnostic`, an `Option<CelSyntaxDiagnostic>` — the first thing that could not be read, held exactly when the whole source could not be read. Node answers a `diagnostics` list of at most one entry; here that is the `Option`. The tree is always there: it keeps what was understood, with an `Unparsed` node where the rest would have been.

- `ParseOptions { limits, optional_syntax }`. `optional_syntax` turns on `[?x]` and `{?k: v}`; off, the question mark is a misplaced token. `ParseOptions::default()` is Node's defaults.
- `CelParseLimits` holds the five limits — `max_nodes` (100000), `max_depth` (250), `max_list_elements` (1000), `max_map_entries` (1000), `max_call_arguments` (32). Its `Default` is `DEFAULT_PARSE_LIMITS`, and a partial override is a struct update. A limit reached is a `limit_exceeded` diagnostic like any other, so the prefix is kept.
- `CelSyntaxCode` is the closed set of Node's sixteen codes, written by `as_str()` (`unexpected_token`, `unterminated_string`, `limit_exceeded`, …). A code is never derived from a message.
- The words: `RESERVED_WORDS` (cel-spec's 21), `LITERAL_WORDS`, `OPERATOR_WORDS`, `is_reserved_word`, `is_identifier_spelling`. A reserved word is refused as an identifier and accepted as a member name.

**Not supported yet:** the namespace pass (`qcall` is a kind of the tree, and nothing here produces one), writing a tree back as source, the tree queries, types, checking, evaluation and the function catalog. Each arrives with its own files — see the table.

## Files

Each file twins the `cel/nodejs/src` file of its name; `lib.rs` twins `index.ts`. Every public item is exported at the crate root.

| File | Twins | Public items | Node items with no twin |
|---|---|---|---|
| `reserved_words.rs` | `reserved-words.ts` | `RESERVED_WORDS`, `LITERAL_WORDS`, `OPERATOR_WORDS`, `is_reserved_word`, `is_identifier_spelling` | — (the word reading is private, as on Node's entry) |
| `syntax_diagnostic.rs` | `syntax-diagnostic.ts` | `CelSyntaxCode`, `CelSyntaxDiagnostic` | — (the first-diagnostic holder is private, as on Node's entry) |
| `parse_limits.rs` | `parse-limits.ts` | `CelParseLimits`, `DEFAULT_PARSE_LIMITS` | `resolveParseLimits` — the limits are one struct with a `Default` |
| `syntax_tree.rs` | `syntax-tree.ts` | `CelNode`, one struct per kind, `CelListElement`, `CelMapEntry`, `CelLiteral`, `CelUnaryOperator`, `CelBinaryOperator`, `SourceRange`, `child_nodes`, `walk_tree` (`TreeWalk`), `has_unparsed` | — |
| `tree_equality.rs` | `tree-equality.ts` | `trees_equal` | — |
| `lexer.rs` | `lexer.ts` | none (the tokenizer and its token are private, as on Node's entry) | `MAX_INT`, `MIN_INT`, `MAX_UINT` — the range is the type; the chunked code-unit-to-text helper; every raw-lone-surrogate path |
| `parser.rs` | `parser.ts` | `parse_syntax`, `ParseOptions`, `ParseResult` | `ParseResult.diagnostics`, a list of at most one — it is `diagnostic`, an `Option` |

Node files not twinned yet, by what brings them:

- **The pass, the writer and the queries (next):** `namespace-resolution.ts`, `cel-expression.ts`, `serializer.ts`, `comprehension-bindings.ts`, `qualified-calls.ts`, `root-references.ts`.
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

Stack use is constant. The parser holds its pending grammar positions on the heap rather than in call frames, and walking, the hole test, both equalities, `Debug`, `Clone` and `Drop` each run on a heap work list. So:

- `max_depth` bounds **heap, not stack**. It is still Node's limit, counted as Node counts it and refused with the same diagnostic at the same place; raising it costs memory only.
- A chain is not nesting. `1+1+…` and `a.b.c…` read up to the node limit as left-deep trees fifty or a hundred thousand deep, and a hand-built tree has no bound at all. Each is walked, compared, written and released like any other — where Node's own walkers throw `RangeError`.

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
- A raw single-line literal continues across a backslash followed by a line feed, and a backslash that ends the source is content.
- A single-line literal holds a raw carriage return.
- A character outside the basic plane where no token can stand is reported as its leading surrogate over one code unit.
- A range may end past the end of the source.

## Tests

`tests/lexer.rs` and `tests/parser.rs` are the twins of `cel/nodejs/tests/lexer.test.ts` and `parser.test.ts`, case for case. One assertion waits: the write-back half of "reads any word as a member name", which needs the serializer.

Past the twins, for what Node's tests leave unasserted: `syntax_diagnostic.rs` (every code and message template), `interim_readings.rs`, `double_literal.rs` (bit patterns of the hard decimal cases), `syntax_tree.rs` (traversal and the two equalities), `reserved_words.rs`, and `deep_tree.rs`, which runs wholly on a 256 KiB stack. `tests/support/mod.rs` builds literal trees and holds a read source to a recorded answer.

**Every expected tree, code, message, range, bit pattern and boundary number was produced by executing the Node build**, not by reading it. The procedure: the Node build's `parseSyntax` is run on the same sources under the same options, and what it answers is recorded — the tree with every range, and the diagnostic's code, message and range; for the traversal and equality tables, what `walkTree`, `childNodes`, `hasUnparsed` and `treesEqual` answer. Each file's header names the package version and the commit it was run at. The exceptions are this crate's own answers, each named where it is asserted: the two differences above, `==` on a node, the `Debug` text, and the properties Node cannot answer because its walkers throw — that a deep tree is handled at all, and every read under raised limits. The tests read no file outside this directory.

Semantics shared with the Node engine, and the reasons behind them, are in `cel/nodejs/CLAUDE.md` ("The front end", "The grammar is cel-spec's", "The reserved set").
