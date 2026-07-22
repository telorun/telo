# IDE completion — AST-driven context + whole-node replacement

Rework completion in `@telorun/ide-support` so it derives cursor context from the
manifest AST instead of line/regex/indent heuristics, then use the resolved node's
source range to replace the whole node on accept (fixing suffix breakage).

Two sequenced parts, on top of an analyzer change that gives the analyzer its own
read-only AST types — for both the YAML structure and the CEL expression trees inside
it — so `ide-support` no longer imports the `yaml` or `cel-js` packages.

- **Part 0** (analyzer) — read-only YAML **and** CEL AST types + `parseToAst`; de-leak
  the position API. The CEL substrate is prepared here so CEL autocomplete slots in
  later without reshaping the AST.
- **Part 1** (ide-support) — resolver + AST-driven `detectContext`. `detectContext` /
  `buildCompletions` gain an optional pre-parsed `AstDocument[]`; with none supplied they
  parse locally, so Part 1 stands alone.
- **Part 2** (ide-support + hosts) — whole-node replacement via a full replace range.

## Motivation

- [detect-context.ts](../src/completions/detect-context.ts) reconstructs manifest
  structure by hand — line splitting, `kind:`/`name:`/`capability:` regexes, and
  backward indent-walking in `buildYamlPath` — a reimplementation of what the AST
  already knows. [extractInFileResources](../src/completions/build.ts) re-scans text
  with regex for `(kind, name)` pairs.
- Accepting a completion replaces only the prefix: `CompletionResult.replaceFromColumn`
  anchors a range from a column → the cursor. Text *after* the cursor is never
  replaced, so `kind: Sql.Co|nnection` + accept → `Sql.Connectionnnection`. Both hosts
  build that prefix-only range ([vscode](../../../ide/vscode/src/completion.ts),
  [monaco](../../../apps/telo-editor/src/components/views/source/register-completion.ts)).
- The analyzer leaks `yaml` package types through its public API
  ([`LoadedFile.documents: Document[]`](../../../analyzer/nodejs/src/loaded-types.ts),
  [`buildPositionIndex(doc: Document)`](../../../analyzer/nodejs/src/position-metadata.ts)),
  forcing any AST consumer to depend on `yaml` directly.

## Decisions (settled)

- **The analyzer owns a read-only AST.** It exports its own node interfaces + a
  `parseToAst` entry; `yaml` becomes an internal implementation detail. This is the
  shared, browser-safe structural source of truth for every IDE feature.
- **The analyzer also owns the CEL AST type.** A scalar node exposes its embedded CEL
  expression tree through an analyzer-owned `CelNode` union; `@marcbachmann/cel-js`
  stays an internal detail (parsing + type-check), never in the public surface. Full
  symmetry with the `yaml` decision — no third-party AST type leaks. Prepared now,
  because CEL autocomplete will need cursor→CEL-node resolution.
- **`ide-support` depends on the analyzer AST, not `yaml`.** The completion resolver
  (and later hover / rename / code actions) are built as *locate (read-only AST) →
  emit `TextEdit`s*. `ide-support` drops its `yaml` dependency; it parses via the
  analyzer's `parseToAst`, never `parseAllDocuments`.
- **The mutable document model stays in the telo-editor.** LSP-style features need
  only read + edit-emission, so no mutable model belongs in `ide-support`. The
  editor's round-trip model ([ast-ops.ts](../../../apps/telo-editor/src/loader/ast-ops.ts),
  [subgraph.ts](../../../apps/telo-editor/src/loader/subgraph.ts)) — still `yaml.Document`
  today — is untouched here. De-`yaml`-ing that model is a separate follow-up.
- **No general text fallback, only two bounded cursor-line carve-outs.** Empty value
  slots, blank-line-in-container, and whole-node ranges are first-class AST results, not
  regex (verified: yaml emits an explicit `null` scalar at an empty slot, and a blank
  line resolves to its enclosing map via the range gap). Structural malformation at the
  cursor otherwise returns nothing (next keystroke re-parses). The two carve-outs are the
  cases where the AST *cannot* classify the cursor and a cursor-line check is required:
  (1) a **partial key with no colon** — yaml parses the text as the parent's value
  scalar, so key-vs-value needs the line's following-`:` check; (2) an **open CEL region**
  — an unclosed `${{` (`foo: "${{ req|`), inherently mid-token, whose enclosing scalar
  yaml reports as malformed (`MISSING_CHAR`) and may swallow following lines. Both get
  tolerant, cursor-anchored recovery — never the removed indent-walking machine.

## Part 0 — analyzer read-only AST

### YAML node model

New read-only node model (byte-offset ranges, mirroring `yaml`'s so `offsetToPosition`
still applies). Illustrative shape:

```
type AstNode =
  | { kind: "map";    range: [number, number]; entries: AstPair[] }
  | { kind: "seq";    range: [number, number]; items: AstNode[] }
  | { kind: "scalar"; range: [number, number]; value: unknown; tag?: "!cel" | "!ref" | string;
      celSegments(): CelSegment[] };   // lazy — see CEL model below
interface AstPair { key: AstNode; value?: AstNode }
interface AstDocument { root?: AstNode; range: [number, number] }
```

- New `parseToAst(text): AstDocument[]` — wraps `parseAllDocuments(text, { customTags })`
  and adapts the `yaml` tree into `AstNode` (a thin lazy view, not a copy). Tagged
  scalars (`!cel` / `!ref`) surface their `tag` so the resolver can recognise ref/CEL
  sites — ranges survive here, unlike the `toJSON()` sentinel projection.
- Migrate `buildPositionIndex` / `buildDocumentPositions` to accept `AstNode` /
  `AstDocument` instead of `yaml.Document`, de-leaking their public signatures.
  `parse-loaded-file.ts` feeds them the adapted view.
- `LoadedFile.documents` **stays `yaml.Document[]`** — the editor's mutable handle.
- Export from the analyzer barrel: `AstNode`, `AstPair`, `AstDocument`, `parseToAst`.

### CEL node model

A scalar node's CEL content is reached through `celSegments()` (lazy — nothing parses
CEL during `parseToAst`; only the expression under the cursor is parsed on demand).

```
interface CelSegment {
  range: [number, number];   // segment span in DOCUMENT offsets (incl. the ${{ }} for interpolation)
  source: string;            // the CEL body (a prefix when `open`)
  open: boolean;             // true when the `${{` has no closing `}}` yet (mid-typing)
  ast(): CelNode;            // lazily parse + wrap; ranges already absolute
}
type CelNode =
  | { kind: "literal";    range; value: unknown }
  | { kind: "ident";      range; name: string }
  | { kind: "member";     range; target: CelNode; property: string; propertyRange; optional: boolean }  // . / .?
  | { kind: "index";      range; target: CelNode; index: CelNode; optional: boolean }                   // [] / [?]
  | { kind: "call";       range; name: string; args: CelNode[] }                                        // call
  | { kind: "methodCall"; range; name: string; receiver: CelNode; args: CelNode[] }                     // rcall
  | { kind: "list";       range; items: CelNode[] }
  | { kind: "map";        range; entries: { key: CelNode; value: CelNode }[] }
  | { kind: "ternary";    range; cond: CelNode; then: CelNode; else: CelNode }
  | { kind: "unary";      range; op: string; operand: CelNode }
  | { kind: "binary";     range; op: string; left: CelNode; right: CelNode };
// every `range` is [number, number] in document offsets
```

- A `wrapCelAst(celJsNode, segmentStart)` maps `@marcbachmann/cel-js` `ASTNode` → the
  analyzer `CelNode`, translating each node's segment-relative `start`/`end` to absolute
  document offsets by adding `segmentStart`. `member` keeps the property's own range
  (cel-js records it) so a later rename can target just the `.prop`.
- `celSegments()` builds segments from the scalar: a `!cel` scalar → one segment
  spanning the value; a `${{ }}`-interpolated string → one per `${{ }}` match. `cel-js`
  is invoked only inside `ast()`.
- **Open (unclosed) segments.** Beyond the closed `${{ }}` matches, `celSegments()` also
  yields a segment for a trailing `${{` with **no** matching `}}` — running from `${{`
  to the scalar/line end, `open: true`, `source` = the partial body. For an `open`
  segment, `ast()` parses leniently (longest valid prefix; `req` is a valid ident,
  `req.` tolerated) rather than requiring a complete expression. This is what makes
  completion fire while the user is still typing inside `${{`.
- **Malformed-quote recovery.** An unterminated string (`foo: "${{ req|`) makes the
  `yaml` scalar node unreliable. When the scalar can't be used, `celSegments()` recovers
  the open region from the cursor's line: from the value start, the last `${{` with no
  intervening `}}` is the open segment. Localized and cursor-anchored — not the removed
  indent-walking; the AST still locates the enclosing pair/value start.
- **Templating change (prerequisite):** the `${{ }}` split currently discards each
  segment's offset ([compile.ts](../../../templating/nodejs/src/cel/compile.ts),
  [walk.ts](../../../templating/nodejs/src/cel/walk.ts) return only the trimmed body).
  Add the segment's start offset (from `match.index` + `${{` length + trim delta) to
  that output so `celSegments()` can place segments. Shared by the `!cel` and `!sql`
  engines — additive, no parser change.
- Export from the analyzer barrel: `CelNode`, `CelSegment`, `wrapCelAst`.

Building CEL *completion items* (scoped variables via [buildTypedCelEnvironment](../../../analyzer/nodejs/src/cel-environment.ts),
functions via [CEL_FUNCTIONS](../../../templating/nodejs/src/cel/catalog.ts)) is a later
feature — Part 0 only lands the AST substrate it will stand on.

## Part 1 — AST-driven context detection (`ide-support`)

Resolution runs against the read-only AST, never the JSON projection: `!cel`/`!ref`
lose their range in `toJSON()`.

### New: `src/completions/resolve-node.ts`

`resolveNodeAtPosition(docs: AstDocument[], line, character)` →

```
interface ResolvedCursor {
  docIndex: number;              // which --- document the cursor is in
  path: string[];                // parent-key chain, e.g. ["config", "routes"]
  slot: "key" | "value";         // cursor on a map key or a value
  node?: AstNode;                // node under the cursor, if any
  container?: AstNode;           // nearest enclosing map/seq (for empty slots)
  replaceRange?: { start: Position; end: Position };  // full range of `node`
  cel?: { segment: CelSegment; offset: number };      // set when cursor is inside a CEL body (incl. open)
}
```

When the cursor's node is a scalar carrying CEL and the offset falls inside one of its
`celSegments()` — **closed or open** — `cel` is set (the segment + the document offset).
For the open case (`foo: "${{ req|`) `segment.open` is `true`, signalling prefix parsing.
That's the entry point the future CEL-completion feature consumes (`segment.ast()` +
hit-test the offset against `CelNode` ranges); this refactor only populates it, it does
not build CEL items. Because the open-CEL path is cursor-anchored, it fires even when
the surrounding scalar is malformed, without reviving general text-fallback for
structure.

Steps:
1. Cursor `(line, character)` → byte offset via a line-offset table (analyzer's
   `buildLineOffsets`; offset = line start + character).
2. Select the document whose range contains the offset (multi-doc `---`).
3. Walk the doc for the deepest node whose range contains the offset, tracking `path`,
   `slot` (offset vs the pair's key-range / value-range), and `container` (nearest
   enclosing map/seq).
4. Empty value (`kind: |`) → the explicit `null` scalar yaml emits at the cursor, a
   zero-width range (Part 2 turns this into a pure insert). Blank line inside a map → no
   child node contains the offset; `container` = the enclosing map (its range spans the
   gap), no `node`, `slot = "key"`. Partial key with no colon → yaml parses the text as
   the parent's *value* scalar, so the AST alone can't tell key from value; check the
   cursor line for a following `:` and treat as `slot = "key"` when absent.
5. Malformed / no containing node and no resolvable container → `undefined`.

The path-keying (`config.routes[0].handler`, `@key:` for keys) matches the analyzer's
`buildPositionIndex` convention — now shared, since both consume the same AST.

### Rewire `detect-context.ts`

`detectContext(text, line, character, docs?)` uses the supplied `AstDocument[]` when the
host passes one, else falls back to `parseToAst(text)`; it then runs
`resolveNodeAtPosition` and maps `ResolvedCursor` onto the existing `CompletionCtx`
union — same variants (`kind | capability | prop-key | ref-name | field-value`), same
fields `build.ts` consumes. `docKind` = the document's top-level `kind` scalar. Delete
the regex/indent helpers (`findDocBounds`, `extractKindFromDoc`, `extractRootKeys`,
`buildYamlPath`, `extractKeysAtIndent`, `findSiblingKindValue`). Keep the
schema-navigation helpers (`peelCombinators`, `navigateSchema`, `unionLeaves`,
`lookupRefConstraint`) — they walk the analyzer JSON Schema, unrelated to source
structure. Replace [extractInFileResources](../src/completions/build.ts) with an AST
walk (top-level `kind` + `metadata.name` per doc).

`buildCompletions` gains the same optional `docs?: AstDocument[]` (threaded to
`detectContext`); the `CompletionCtx` shape and both hosts are otherwise unchanged in
Part 1. Drop `yaml` from `packages/ide-support/package.json`.

## Part 2 — whole-node replacement (`ide-support` + hosts)

- `CompletionResult` (`src/types.ts`): replace `replaceFromColumn?: number` with
  `replaceRange?: { start: Position; end: Position }`, fed by the resolved node's full
  source range. Empty slot with no node → zero-width point at the cursor (pure insert).
- Each `CompletionCtx` variant carries `replaceRange` instead of `valueStartColumn`;
  `build.ts` copies it onto every emitted `CompletionResult` (kind, ref-name,
  import-source).
- Hosts pass their already-parsed `AstDocument[]` into `buildCompletions` so completion
  reuses one parse instead of re-parsing per keystroke (guarded by text identity; a
  stale/absent parse falls back to the local `parseToAst`). This closes the double parse
  Part 1 left as a fallback.
- Hosts apply a TextEdit over the whole range:
  - [ide/vscode/src/completion.ts](../../../ide/vscode/src/completion.ts) — build
    `vscode.Range` from `replaceRange` for `item.range`.
  - [register-completion.ts](../../../apps/telo-editor/src/components/views/source/register-completion.ts) —
    build the Monaco `range` (1-based) from `replaceRange`.

Makes `kind: Sql.Co|nnection` + accept replace the whole `Sql.Connection` scalar.

## Tests

- Analyzer `parse-to-ast.test.ts` — node shape + ranges for map/seq/scalar, `!cel` /
  `!ref` tag surfacing, multi-doc.
- Analyzer `cel-segments.test.ts` — `celSegments()` on a `!cel` scalar (one segment,
  whole value) and a `${{ }}`-interpolated string (one per match, correct document
  offsets); `wrapCelAst` node kinds + absolute ranges for member/index/call/ternary,
  including nested `variables.po|rt` offset mapping.
- `resolve-node.test.ts` (CEL) — open unclosed segment `foo: "${{ req|` sets
  `cel.segment.open = true` with the right offset; unterminated-quote recovery still
  yields the open segment when the scalar is malformed; closed `${{ x }}` sets
  `open = false`; cursor in the literal text outside `${{ }}` sets no `cel`.
- `resolve-node.test.ts` — top-level `kind` value, nested value, empty value slot,
  blank line in a map, partial key without colon, cursor on a `!ref` / `!cel` scalar,
  multi-doc selection, malformed → `undefined`.
- Extend `completion-build.test.ts` — assert `replaceRange` spans the whole existing
  node (suffix-after-cursor included), covering the `Sql.Co|nnection` regression.

## Out of scope

- De-`yaml`-ing the telo-editor's mutable round-trip model (separate follow-up).
- Implementing hover / rename / code actions. The analyzer read-only AST + the
  `ide-support` locate→emit-`TextEdit` shape are chosen to enable them, but none are
  built here.
- CEL autocomplete itself — completion items inside `!cel` / `${{ }}` bodies. Part 0
  lands the CEL AST substrate (`CelNode`, `CelSegment`, cursor→segment in
  `ResolvedCursor.cel`); the feature (wiring `CelNode` hit-testing to scoped variables
  + the function catalog) is separate.
