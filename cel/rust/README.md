# telorun-cel

The CEL language for Rust: the Rust half of `@telorun/cel` (`cel/nodejs`). Today it holds the engine's **front end** and its **type system**. The front end reads CEL source into the ranged syntax tree, with the input limits and error recovery; resolves namespace-qualified calls; writes a tree back as source; and answers the two questions a consumer asks of a tree — what it reads, and which namespaced functions it calls. The type system is the static types, type text and signatures, the function registry with the standard library, and an environment's registrations and listing. It answers as the Node engine answers: the same tree, the same diagnostic code, message and range, the same written text, the same refusals, the same query results, the same types and the same listing, for every input.

It stands on `telorun-cel-value` (`cel/rust/value`), the value domain, and takes its `SourceRange` from there.

## Rules

- **One dependency.** `[dependencies]` is exactly `telorun-cel-value`, by path, and no registry crate. `cargo tree -p telorun-cel -e normal` prints two lines. The one dev-dependency is `serde_json`, pinned to the version the workspace lock already holds; it reads the conformance vectors in one test and reaches nothing under `src/`.
- **No host vocabulary.** No kind, annotation, tag or manifest word appears in `src/`. The crate owns CEL and nothing above it.
- **One file read from outside.** `src/` reads exactly one file outside this directory: the standard library's signature data, `cel/nodejs/src/signatures/standard-library.json`, the file the Node engine reads, taken in at build time. The library is declared once, for both engines.
- **No recursion on input.** No function recurses in proportion to a source or a tree. See *Depth* below.
- The crate is `publish = false`, licensed MIT, and carries `@telorun/cel`'s version: the two are one artifact in two languages, stamped together by the version step.

## What it does, and what it does not yet

**Supported: reading.** `parse_syntax(source: &str, options: &ParseOptions) -> ParseResult` reads one expression and never fails; the defaults are written `&ParseOptions::default()`. It answers a `ParseResult`: the `source` (an `Arc<str>`, the text copied once when it is read and shared by every later holder), the `root` of the tree (an `Arc<CelNode>`), and `diagnostic`, an `Option<CelSyntaxDiagnostic>` — the first thing that could not be read, in source order, held exactly when the whole source could not be read. Node answers a `diagnostics` list of at most one entry; here that is the `Option`. The tree is always there: it keeps what was understood, with an `Unparsed` node where the rest would have been. Text no token can be read from ends the reading where it begins, so the tree is the tree of the source cut there, and the diagnostic is whichever starts first — the cut source's own, or the unreadable text's, which also wins a tie.

- A member left unnamed — `a.`, and ``a.`` `` with nothing between its backticks — is a select with an empty field and `quoted: false`.
- `ParseOptions { limits, optional_syntax }`. `optional_syntax` turns on `[?x]` and `{?k: v}`; off, the question mark is a misplaced token. `ParseOptions::default()` is Node's defaults.
- `CelParseLimits` holds the five limits — `max_nodes` (100000), `max_depth` (250, the nesting of the grammar and the height of the tree — see *Depth*), `max_list_elements` (1000), `max_map_entries` (1000), `max_call_arguments` (32). Its `Default` is `DEFAULT_PARSE_LIMITS`, and a partial override is a struct update. A limit reached is a `limit_exceeded` diagnostic like any other, so the prefix is kept.
- `CelSyntaxCode` is the closed set of Node's sixteen codes, written by `as_str()` (`unexpected_token`, `unterminated_string`, `limit_exceeded`, …). A code is never derived from a message.
- The words: `RESERVED_WORDS` (cel-spec's 21), `LITERAL_WORDS`, `OPERATOR_WORDS`, `is_reserved_word`, `is_identifier_spelling`. A reserved word is refused as an identifier — the name a leading dot opens included, so `.true` is refused as `.while` is — and accepted as a member name.

**Supported: the namespace pass.** `Alias.fn(x)` and `obj.method(x)` are one syntax, so only a set of names that denote namespaces can tell them apart, and the reader has no such set.

- `normalize_namespaces(names) -> Result<Vec<String>, CelNamespaceError>` validates a set and puts it in canonical order: sorted, each name once. A name that is not spelled as an identifier, is a reserved word, or is `cel` or `optional` (`RESERVED_NAMESPACES` — the standard macros are written on them) is refused. `namespace_sets_equal` compares position by position, so it is a set comparison only when both sides are normalized.
- `resolve_namespaces(root: &Arc<CelNode>, namespaces) -> Arc<CelNode>` rewrites every call on a bare, non-absolute name of the set into a `QualifiedCall`, wherever it stands. It is the only producer of that kind. What it does not rewrite it shares: an unchanged subtree is the same `Arc`, and a tree nothing moved in — or any tree under an empty set — is the root it was given. Its answer depends on membership alone: the order of the names and a name given twice change nothing. It does not validate the names, so a set that did not come from `normalize_namespaces` may hold `cel` or `optional` and capture the standard macros; `parse_expression` is the path that always validates.

**Supported: an expression, read and resolved.** `parse_expression(source: &str, options: &ParseExpressionOptions) -> Result<CelExpression, CelNamespaceError>` is the front end's whole answer, and the pass always runs.

- `ParseExpressionOptions { parse, namespaces }` holds the reader's `ParseOptions` whole — handed to `parse_syntax` unchanged — and the namespace names. `ParseExpressionOptions::default()` is Node's defaults: no namespace.
- `CelExpression { source, root, namespaces, diagnostic }`: the reader's `source`, the resolved `root`, the set the tree was resolved under in canonical order, and the reader's `diagnostic`. All but the diagnostic are shared (`Arc<str>`, `Arc<CelNode>`, `Arc<[String]>`), so a clone copies no text and no tree. As for `ParseResult`, Node's `diagnostics` list of at most one entry is the `Option`.
- `resolved_under(&expression, names) -> Result<bool, CelNamespaceError>` says whether the expression was resolved under exactly that set.
- The only `Err` is a namespace set no host can have. A source that cannot be read is still an `Ok` holding its diagnostic.

**Supported: writing a tree back.** `serialize_tree(root: &CelNode) -> Result<String, CelSerializeError>` answers Node's text for every tree Node writes.

- **The contract is a round trip under the options the tree was read with.** The text written for a tree that read with no diagnostic reads back to an equal tree (`trees_equal`) when it is read with the same options: an optional entry (`[?x]`, `{?k: v}`) is written wherever the tree holds one and reads back only with `optional_syntax` on, and a qualified call is written as `Alias.fn(x)` and reads back as one only under its namespace. The writer takes no options. That is the whole contract and it has no exception.
- Parentheses come from precedence, with one pair more: the non-negative int or double the operand of a unary minus begins with — the operand itself, or the start of its member, index and method chain — is written in parentheses (`-(1)`, `-(1).a`, `-(1)[0]`), because the reader folds a minus into the number after it. A string is always between double quotes, a bytes literal is always `b"…"`, a member name that is not spelled as an identifier is between backticks, and a double is written as ECMAScript writes a number — `1e+21`, `0.000001`, `100.0` — with `1e999` and `-1e999` for the infinities.
- It refuses what has no source: an `Unparsed` hole, a double that is not a number, a name, function name or namespace that is not a name, and a member name holding a backtick or a line feed, or empty. A tree with several such faults reports the first in the order the text is written, as Node does.

**Supported: the two tree queries.**

- `qualified_calls(root) -> Vec<QualifiedCall>`: every call on a namespace, a call before any call written inside it, each with its namespace, name, `qualified_name`, arity and ranges. Only a resolved tree holds one, so the answer is relative to the set the tree was resolved under.
- `root_references(root) -> Vec<String>`: the first name of every access chain, sorted, each once. A name a comprehension or `cel.bind` binds is not one inside the arguments the binding reaches; the namespace of a qualified call is not one; and neither is `cel` or `optional` as the receiver of a call.
- The binding forms are data, shared with whatever lowers them later: `BINDING_FORMS`, `receiver_macro_binding(name, arity)` and `namespace_macro_binding(namespace, name, arity)`, each answering a `ComprehensionBinding` — the argument that is the bound name, and the arguments evaluated with it in scope. An arity the table does not list binds nothing.

**Two error types.** `CelNamespaceError` and `CelSerializeError` are plain `std::error::Error` structs carrying Node's `message`, a quoted name written as `JSON.stringify` writes it. Neither has a code: Node's have none. Where Node throws one, the function here answers it as an `Err`.

**Supported: types.** `CelType` is Node's nine kinds: `Dyn`, `Primitive(PrimitiveName)` (ten names), `List`, `Map`, `Optional`, `Record` (an optional name, its `fields`, and whether it is `open`), `Union`, `Nominal` (a named type: name, base, invariant arguments, optional fields) and `Parameter`.

- **Shared and immutable.** Every child and every collection is an `Arc`, so `Clone` is shallow; a type is `Send + Sync`. A record's or a named type's fields are a `TypeFields`, with JavaScript `Map` semantics: insertion order, a name set again keeps its first position and takes the new type.
- **A union is built only by `union_of`**: nested unions are flattened, members are deduplicated by `types_equal` in first-seen order, one member is that member, and no member — or any `dyn` — is `dyn`. Its members are private, so a union Node's engine never builds has no spelling. Deduplication finds candidates through a hash read from a member's own level, so a union of distinct members is built in time that grows with the members.
- **Two equalities.** `types_equal` is Node's and the only one the engine's rules use: a record's fields in any order, a union's members in order, a named type by its name and arguments only. `==` is the type as data — field order, a named type's base and fields included — for tests. A type is `Eq`, and not `Hash`.
- **`format_type(ty, top)`** prints as Node prints: `list` / `map` for a list or map of `dyn` at the top, `a|b`, `Name<A, B>`, `null`, `google.protobuf.Timestamp`, and `map` for an unnamed record. That text is a signature's dispatch key, so two unnamed records collide as `map`, as on Node.
- Node's functions: `assignable`, `unify`, `without_parameters`, `admits_null`, `without_null`, `is_dyn`, `is_numeric`, the builders `list_of`, `map_of`, `optional_of`, `parameter_of`, `union_of`, the constants `DYN` … `DURATION`, and `WELL_KNOWN_TYPE_NAMES`.
- `CelTypeValue` (the value crate's answer of `type()`) is unrelated: nothing converts between it and a static type.

**Supported: type text and signatures.** `parse_type_expression(text, resolver)` reads `list<int>`, `map<string, int>`, `optional<T>`, a single capital letter as a type parameter, and asks the `NominalResolver` — a function from a name and its arguments to `Result<Option<CelType>, CelTypeRegistrationError>` — for any other name, after that name's arguments are read; a name it does not resolve is a `CelUnknownTypeNameError`. It answers `CelTypeTextError`: `Expression`, `UnknownName` or `Registration`. `parse_signature` reads `name(a, b): r` and `Receiver.name(a): r` as Node's pattern does — see *Interim readings* for its whitespace — reading the parameters, then the receiver, then the result. `format_signature` and `signature_key` (the dispatch key, without the result) print one. `CelSignature { name, receiver, parameters, returns }` derives its `form()` from the receiver.

**Supported: the registry.** `FunctionRegistry` registers last-wins by dispatch key, a replacement keeping its place; `remove`, `remove_name`, `has`, `named`, `list` (name in UTF-16 code-unit order, then registration order) and `candidate_names` (form and arity a filter; edit distance over code units, then name; at most `UNKNOWN_FUNCTION_CANDIDATES`).

- `register` refuses a signature taking more than `CALL_SITE_DIRECT_ARITY` (4) values, the receiver counting as one: a `CelEngineError` of code `signature_too_wide`, `<signature> takes <n> values and an implementation receives at most 4`. `CelEngineErrorCode` is Node's four codes; `namespaces_mismatch` and `unreadable_expression` arrive with checking and evaluation, and `emitted_module_rejected` is raised by nothing here, there being no emitter.
- `resolve(name, form, args, receiver)` answers a `Resolution` (the registration and its return type with the call's bindings substituted) or a `ResolutionFailure` whose reason is `unknown`, `wrong-form` or `no-overload`, with the candidates considered. An exact pass, then a loose one where `dyn` makes a candidate viable and several viable candidates that disagree on their return answer `dyn`. A type parameter is bound by the first argument that mentions it. `substitute`, `describe_candidates` and `describe_arguments` are Node's.
- `FunctionMetadata { check_arguments, deterministic, host_backed, throws, description, origin }` is written with `..FunctionMetadata::default()` (`deterministic` true). `check_arguments` is a `LiteralArgumentCheck`, asked by the checker when it arrives; the implementation slot arrives with evaluation.

**Supported: the standard library.** `register_standard_library(registry, StandardLibraryOptions { optional_types, resolve_nominal })` registers Node's signature data through `register`, so a standard signature is replaceable and removable; `standard_constants`, `standard_library_signatures` and `STANDARD_LIBRARY_GENERATION` (1, checked against the data) are Node's. The data is parsed once per process; a file this engine cannot read is a defect of the engine and panics naming the entry.

**Supported: the environment's registrations and listing.** `CelEnvironment::new(CelEnvironmentOptions { unlisted_variables_are_dyn, homogeneous_aggregate_literals, enable_optional_types, limits, standard_library })` — `Default` is Node's defaults, the standard library on. `Clone` is Node's `clone()`; `clone_with_options(options)` is `clone(options)`, the caller merging by struct update from `options()`. On a clone, `standard_library` and `enable_optional_types` register nothing, as on Node.

- `register_function(text or CelSignature, metadata)`, `remove_function`, `remove_functions_named`, `register_operator(operator, parameters, returns, metadata)`, `register_variable` / `register_constant(name, TypeDeclaration, description)` (`TypeDeclaration` is `Text` or `Type`), `has_variable`, `register_type(NominalTypeDefinition)`, `register_namespace(name, declarations, NamespaceOptions { open })`, `namespaces()`.
- A namespaced function is a `NamespaceFunctionDeclaration` of `NamespaceFunctionForm::Signature(text)` or `Withheld { name, returns }` (its parameter list withheld), with `deterministic`, `host_backed` and `throws`; a type name nothing is registered under is accepted, reads `dyn` and is recorded in the `NamespaceFunction`'s `unregistered_types`. A namespace is closed unless `open`.
- `parse(source)` reads against the environment's namespaces and limits, with the optional syntax where optional types are enabled. `converts_to_string(ty)` asks the environment's own `string()`.
- `definitions()` answers Node's listing field for field: `variables` by name in code-unit order, `functions` as the registry lists them (207 by default, 214 with optional types), `types` in registration order — a type registered again keeping its first place — with each field printed, and `namespaces` by name, a withheld function printed `name(…): T`.
- Every fallible registration answers a `CelRegistrationError`: `Expression`, `UnknownName`, `Registration`, `Engine` or `Namespace` — the class Node throws, as a variant.

**Supported: JSON text.** `scan_json_prefix(text)` answers Node's refusal — the offset in UTF-16 code units where the text stops being a prefix of any RFC 8259 JSON text, and whether that is its end — or nothing for JSON. `read_json_text(text)` reads exactly what the scan accepts into a `JsonValue` (`Null`, `Bool`, `Number(f64)`, `String`, `Array`, `Object`), a key written twice taking its last value at its first position, an object's keys in ECMAScript's own-property order, every object and array its own `Arc`. It answers `JsonTextError::NotJson(refusal)` or `UnpairedSurrogate { offset }`.

**Not supported yet:** typing from JSON Schema — `TypeDeclaration`'s field-map and schema forms, the schema resolver and the schema reports — and checking, which arrive with this engine's next steps; evaluation and the function catalog. Each arrives with its own files — see the table.

## Files

Each file twins the `cel/nodejs/src` file of its name; `lib.rs` twins `index.ts`; `json_value.rs` alone has no Node twin. Every public item is exported at the crate root, and the exports are the front-end block of Node's entry plus its comprehension-binding table and the type system's items twinned so far, less the items listed as having no twin and `declared-chain.ts`, which arrives with the checker.

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
| `cel_type.rs` | `cel-type.ts` | `CelType`, `PrimitiveName`, `ListType`, `MapType`, `OptionalType`, `RecordType`, `UnionType`, `NominalType`, `ParameterType`, `TypeFields`, the constants, `WELL_KNOWN_TYPE_NAMES`, `list_of`, `map_of`, `optional_of`, `parameter_of`, `union_of`, `is_dyn`, `is_numeric`, `admits_null`, `without_null`, `types_equal`, `format_type`, `without_parameters`, `assignable`, `unify` | `DynType`, `PrimitiveType` — variants holding no struct; a union Node's engine never builds |
| `type_expression.rs` | `type-expression.ts` | `parse_type_expression`, `NominalResolver`, `CelTypeExpressionError`, `CelUnknownTypeNameError`, `CelTypeTextError` | — |
| `signature.rs` | `signature.ts` | `CallForm`, `CelSignature`, `parse_signature`, `format_signature`, `signature_key`, `LiteralArgumentCheck`, `FunctionMetadata` | `CelSignature.form` as a field (it is derived); `FunctionMetadata.implementation`, arriving with evaluation |
| `nominal_type.rs` | `nominal-type.ts` | `NominalTypeDefinition`, `NominalOperatorDeclaration`, `CelTypeRegistrationError` | `RegisteredType` — nothing public yields one; its `fieldNames`, arriving with evaluation |
| `check_diagnostic.rs` | `check-diagnostic.ts` | `CelEngineError`, `CelEngineErrorCode` | Arriving with the checker: `CEL_CHECK_CODES`, `CelCheckCode`, `CelCheckDiagnostic`, `CelDiagnosticFix`. No twin: `DiagnosticList` |
| `runtime_library.rs` | `runtime-library.ts` | `CALL_SITE_DIRECT_ARITY` | Arriving with evaluation: every other item |
| `function_registry.rs` | `function-registry.ts` | `FunctionRegistry`, `RegisteredFunction`, `Resolution`, `ResolutionFailure`, `ResolutionFailureReason`, `UNKNOWN_FUNCTION_CANDIDATES`, `substitute`, `describe_candidates`, `describe_arguments` | — |
| `standard_library.rs` | `standard-library.ts` | `STANDARD_LIBRARY_GENERATION`, `StandardConstant`, `StandardLibraryOptions`, `standard_constants`, `register_standard_library`, `standard_library_signatures` | `googleTypeNames`, arriving with evaluation, its only reader |
| `json_value.rs` | — | `JsonValue` | — (a JavaScript value is what Node's schemas and `JSON.parse` hand over) |
| `json_text_scan.rs` | `json-text-scan.ts` | `scan_json_prefix`, `JsonRefusal`, `read_json_text`, `JsonTextError` | — |
| `checker.rs` | `checker.ts` | `NamespaceFunction` | Arriving with the checker: `CheckResult`, `checkExpression`, its crate-private context and its options |
| `environment.rs` | `environment.ts` | `CelEnvironment`, `CelEnvironmentOptions`, `TypeDeclaration`, `SignatureDeclaration`, `NamespaceFunctionDeclaration`, `NamespaceFunctionForm`, `WithheldReturns`, `NamespaceOptions`, `Definitions`, `VariableDefinition`, `FunctionDefinition`, `TypeDefinitionListing`, `NamespaceListing`, `CelRegistrationError` | Arriving with JSON Schema typing: the field-map and schema declarations, `resolveSchemaType`, `schemaReports`, `SchemaRegistrationReport`. With the checker: `check`. With evaluation: `compile`, `evaluate`, `compiledCacheCapacity`, `DEFAULT_COMPILED_CACHE_CAPACITY`, the standard constants' values. No twin: `emit`, `emittedModule`, `emitterRuntime`, `digest`; the "a declaration is …" refusal, which the enum makes unreachable |

Node files not twinned yet, by what brings them:

- **JSON Schema typing:** `json-schema-type.ts`.
- **The checker:** the rest of `checker.ts` and `check-diagnostic.ts`, `macro-shape.ts`, `macro-check.ts`, `nullable-access.ts`, `declared-chain.ts`, `resolved-call.ts`.
- **Evaluation:** `activation.ts`, `member-read.ts`, `value-equality.ts`, `integer-arithmetic.ts`, the rest of `runtime-library.ts`, `comprehension-runtime.ts`, `regular-expression.ts`, `backend-runtime.ts`, `closure-backend.ts`, `cel-program.ts`, `bounded-cache.ts`, the engine halves of `cel-value.ts` and `timestamp-value.ts`, and the emitter's files.
- **The catalog:** `function-catalog.ts`, `catalog-runtime.ts`, `zoned-calendar.ts`.

## The tree

`CelNode` is an enum of thirteen kinds, each holding its own public struct with Node's fields: `Literal`, `Ident`, `List`, `Map`, `Select`, `Index`, `Call`, `ReceiverCall`, `QualifiedCall`, `Unary`, `Binary`, `Conditional`, `Unparsed`. Every node has a `range`, read from any kind with `CelNode::range()`.

- **Shared and immutable.** A single child is an `Arc<CelNode>`; a list of children is a `Vec` of them; list elements and map entries are small structs (`CelListElement`, `CelMapEntry`). `Clone` is shallow. A node is `Send + Sync`.
- **Literals are the tree's own.** `CelLiteral` is `Int(i64)`, `Uint(u64)`, `Double(f64)`, `String`, `Bytes`, `Bool` or `Null` — `1` and `1u` are different expressions. A `-` written directly on an int or a double literal is part of the literal, which is how the int64 minimum and `-0.0` are written. The fold is on tokens: whitespace and comments between the two change nothing (`- 1` is the literal `-1`, ranged from the minus), and a minus before a parenthesis never folds.
- **Macros stay calls.** `has(x)`, `xs.map(i, i)` and `cel.bind(…)` are ordinary call nodes.
- **`Drop` is hand-written**, so a field cannot be moved out of an owned `CelNode` (E0509). Match by reference, or clone the `Arc`.

Traversal is `child_nodes` (every child, in source order), `walk_tree` (depth-first, pre-order) and `has_unparsed`.

### Two equalities

- **`trees_equal(a, b)`** — whether two trees are the same expression. It ignores every range and whether a member was written between backticks; any `Unparsed` equals any `Unparsed`; an absolute name is not the plain one. It is Node's `treesEqual`.
- **`==` on a node** — whether two trees are the same data: every field, every range and `quoted` included. It is what a test compares a read tree to a literal one with. Nodes are deliberately neither `Eq` nor `Hash`.

Both compare a double as itself: NaN equals NaN, and `-0.0` is not `0.0`.

## Depth

Stack use is constant. The parser holds its pending grammar positions on the heap rather than in call frames, and walking, the hole test, both equalities, the namespace pass, the writer, both queries, `Debug` and `Drop` each run on a heap work list. So does the type system: the type-text reader holds its open `<` lists on the heap; printing, both type equalities, `assignable`, `unify`, `without_parameters`, `substitute`, the registry's argument matching, and a type's `Debug` and `Drop` run on work lists, keeping Node's order wherever it is observable (a type parameter is bound by the first argument, left to right, and matching stops at the first part that fails); the JSON scan and reader keep their open containers on the heap, and a `JsonValue`'s `==`, `Debug` and `Drop` run on work lists. No refusal is added for depth.

- **`max_depth` is one limit counting two things**, as on Node: how deep the grammar descends, and how tall the tree is. A node with no child is 1 high; any other is one more than its tallest child. The reader refuses the node whose height exceeds the limit — `limit_exceeded`, `the expression has more nesting than the limit of 250`, ranged over that node, which it keeps — and on one node the node count is judged first. The grammar's own count is refused where it always was, zero-width at the token that would descend too far.
- **A chain is nesting.** `1+1+…` reads with 250 operands and is refused at 251; `a.b.b…` reads with 249 members and is refused at 250. A tree read with no diagnostic is at most `max_depth` high. One read with a diagnostic is at most seven times that — each open grammar level closes around the refused node with a bracket and five binary levels — which is 1750 under the defaults, pinned in `tests/parser.rs`.
- The limit is not for this crate's sake: nothing here recurses. It is the same number on both halves because a tree is handed on to walkers that do recurse, and because two engines must refuse the same sources. Raising it costs memory only: with it out of the way a chain reads to the node limit, fifty or a hundred thousand links deep, and a hand-built tree has no bound at all. Each is walked, compared, resolved, written back, queried and released like any other.
- Release is iterative and shares nothing. Dropping a tree unlinks the descendants it alone owns onto a heap list; beyond that list it makes at most one allocation per release — a placeholder leaf, only when a nested single child has to be taken out of its field — and touches no state another release can see, so trees released on many threads do not contend.

## Positions

A range is a half-open `[start, end)` span of **UTF-16 code units**, as Node's is, whatever the source's UTF-8 width: `'😀'` is four units. The reader counts bytes and units together as it goes, with no position table.

Every range lies within the source and splits no character, so a host can always map one onto a slice of its text:

- A character outside the basic plane is reported whole, named in the message and ranged over its two code units — where no token can stand (`unexpected character "😀"`) and after a backslash (`\😀 is not an escape sequence`, the backslash and both units).
- An escape is ranged as it is written: the backslash, its marker and the run of digits of its radix actually there, up to its width. `"\x` reports `[1, 3)`, `'abc\x4` reports `[4, 7)`. A full-width escape refused for its value keeps its full width.

## Where it differs from Node

- **A source too long to range.** A source of more than 4,294,967,285 UTF-16 code units is refused whole: `limit_exceeded`, `the expression has more UTF-16 code units than the limit of 4294967285`, range `[0, 0)`, and an `Unparsed` root. Node cannot hold such a source.
- **Raw lone surrogates.** Node reads a lone surrogate written raw in a source — in a string or bytes literal, or where no token can stand, where its message holds the one unit. No `&str` holds one, so no such source reaches this crate.
- **Trees deeper than Node's stack.** A hand-built tree, or one read with `max_depth` raised, can be deeper than Node's walkers, its pass, its writer and its queries can finish; they throw `RangeError`. Here each is handled — see *Depth*. So is type text, a type, a signature and a JSON text deeper than Node's reader, printer and comparisons can finish.
- **A name on JavaScript's object prototype.** Node looks a type name up on plain objects before its resolver, so `constructor`, `toString`, `hasOwnProperty`, `valueOf` or `__proto__` as type text reads as that property — `registerVariable("v", "constructor")` declares `v` with no type, which checks as `dyn`. Here such a name is a name like any other: unresolved, a `CelUnknownTypeNameError` (`tests/type_expression.rs`).
- **An escape naming an unpaired surrogate.** `JSON.parse` reads `"\uD83D"` into a string holding a lone surrogate, which no Rust string holds. `scan_json_prefix` accepts it, as Node's does; `read_json_text` refuses it as `UnpairedSurrogate`, at the escape's backslash (`tests/json_text_scan.rs`).

## Numbers

- An integer's magnitude is accumulated in 64 bits with an overflow flag, in either radix, so leading zeros never overflow and no digit count is a limit. A refusal prints the literal as written.
- A double is read by the standard library's correctly rounded parse of the literal's digits, which is what `Number(digits)` answers on Node, bit for bit — including overflow to infinity and underflow to zero. ECMAScript permits an engine less than that past twenty significant digits; the rule here is the correctly rounded one.

## Interim readings

These Node readings are recorded as interim rather than intended. This crate reproduces each until Node changes, because two engines reading one input differently would make two kernels disagree about one manifest. `tests/interim_readings.rs` holds them:

- **A carriage return is content** in a single-line string, a bytes literal and a quoted member name; only a line feed ends one. cel-spec's single-line literal excludes a carriage return. The writer writes a member name holding one.
- **A `list` or `map` with the wrong number of type arguments** reads silently as `list<dyn>` or `map<dyn, dyn>`: `list<int, int>`, `map<int>`, a bare `list`.
- **Signature text is read by ECMAScript's whitespace.** The text is trimmed, and the space around its `:` read, by ECMAScript's set — a byte order mark, U+00A0, U+2028 and every space separator included, U+0085 not — while type text, inside a signature as anywhere, skips only the space character.
- **A named type registered again keeps the signatures** its earlier registration made, and a registration refused part way keeps the type and every signature registered before the refusal.

## Tests

Six files are twins of a `cel/nodejs/tests` file, case for case: `lexer.rs`, `parser.rs`, `namespace_resolution.rs`, `serializer.rs`, `qualified_calls.rs` and `root_references.rs`. One Node assertion has no twin: the writer's refusal of a hand-built int literal of 2^63, which no tree here can hold. Two are twins of the cases that need no `check`: `nominal_type.rs` (`nominal-type.test.ts`) and `namespace_declaration.rs` (`namespace-declaration.test.ts`); their other cases, and every case of `environment.test.ts`, arrive with the checker, and the digest case of `namespace-declaration.test.ts` has no twin.

The type system's tables: `cel_type.rs` (printing, both equalities, unions, assignability, unification, reporting), `type_expression.rs` (every message template and the resolver's order), `signature.rs` (the pattern's corners), `function_registry.rs` (registration, resolution, candidates), `standard_library_listing.rs` (the whole listing, 207 and 214 functions, and the constants), `environment_registration.rs` (every registration refusal, with its class, and the listing of what each registers), `json_text_scan.rs` (refusal offsets and values read), and `deep_types.rs`, which runs wholly on a 256 KiB stack.

Past the twins, for what Node's tests leave unasserted: `syntax_diagnostic.rs` (every code and message template), `interim_readings.rs` (the carriage return), `double_literal.rs` (bit patterns of the hard decimal cases), `syntax_tree.rs` (traversal and the two equalities), `reserved_words.rs`, and `deep_tree.rs`, which runs wholly on a 256 KiB stack. The four twins of the pass, the writer and the queries also go past their Node files, each saying so in its header: the message of every refusal, the text of every literal and name form, where parentheses go, which fault a tree with several reports, and the binding table. `tests/support/mod.rs` builds literal trees and holds a source, an expression or a tree to a recorded answer.

**Every expected tree, code, message, range, bit pattern, boundary number, written text, refusal and query answer was produced by executing the Node build**, not by reading it. The procedure: the Node build's `parseSyntax` is run on the same sources under the same options, and what it answers is recorded — the tree with every range, and the diagnostic's code, message and range; for the traversal and equality tables, what `walkTree`, `childNodes`, `hasUnparsed` and `treesEqual` answer. For the pass, the writer and the queries it is the same: `parseExpression` and `resolveNamespaces` are run under the same namespace set and options and the resolved tree, the recorded set and the identity of what is shared are recorded; `normalizeNamespaces`, `namespaceSetsEqual` and `resolvedUnder` for their answer or the message they throw; `serializeTree` on the same tree — read from a source, or built by hand field for field — for its text or the message it throws; `qualifiedCalls`, `rootReferences` and the binding lookups for what they answer. Each file's header names the package version and the build it was run on, as `@telorun/cel <version> at <commit>`; a row that `main` moves under is executed again and the header updated. The exceptions are this crate's own answers, each named where it is asserted: the refusal of a source too long to range, `==` on a node or a type, the `Debug` text, the class of a refusal as a variant, the refusal of an unpaired surrogate escape, a prototype name read as an unknown name, pointer identity where Node asserts `toBe`, an `Err` where Node throws, and the properties Node cannot answer because its walkers throw — that a deep tree is handled at all, every nesting read under raised limits, and what the pass, the writer and the queries answer on a tree of full length.

### The conformance vectors

`tests/conformance_round_trip.rs` reads `templating/cel-conformance/` in place — the one test that reads outside this directory — and fails when a file is missing. It selects every row of `language.json`, `catalog.json` and `types.json` and every row tagged `cel` of `holes.json`, `module-calls.json` and `verdicts.json`; a row tagged `interpolate` or `sql` holds text with holes, not an expression. It reads only a row's `id`, `source`, `tag` and `modules.names`, never what the row expects.

Each selected source is read with `parse_expression`, the optional syntax on, under the row's module names. A source that reads must hold no hole, write, read back under the same options with no diagnostic, and be the same expression. Pinned from the Node build run on the same selection: each file's row, selected and excluded counts; the exact set of ids that do not read, each with its syntax code; and that the number of `language.json` rows that round-trip is the one Node's own replay of that file reports.

What it does not see: a source both engines read to different trees that each round-trip. The twins, the diagnostic tables and the interim reading hold that class until the vector runners compare the engines' answers row by row.

Semantics shared with the Node engine, and the reasons behind them, are in `cel/nodejs/CLAUDE.md` ("The front end", "The grammar is cel-spec's", "The reserved set", "The registry: nothing is privileged", "The type system").
