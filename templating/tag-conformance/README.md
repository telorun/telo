# Tag conformance vectors

What every manifest loader answers for the tags the templating layer owns: the
expansion tags (`!if`, `!switch`, `!for-each`), the `...` splice key and the
`!ref` grammar. Language-neutral rows; the data is the artifact, and no generator
is committed. The Node loader runs them in `templating/nodejs/tests/tag-conformance.test.ts`,
the Rust loader in `templating/rust/tests/tag_conformance.rs`.

## `ref.json` — the `!ref` grammar

Each row is `{ name, source }` plus exactly one of:

- `parsed: { alias?, name, indexes }` — what the text names. `indexes` is a list
  of `{ binding, member }`, `member` being `key` or `index`; empty for a plain
  reference.
- `refusal: { code, offset }` — the text is outside the grammar. `code` is always
  `REF_MEMBER_INVALID`, `offset` the UTF-16 offset of the first character that
  cannot stand where it is (the text's length when it ends too early).

The grammar has three forms — `<name>`, `<Alias>.<name>`, and `<name>` followed by
one or more `[<binding>.key]` / `[<binding>.index]` — each name an identifier
(`[A-Za-z_][A-Za-z0-9_]*`), no whitespace, no quoting, no alias beside an index.
Compared in full, key order included.

## `sentinels.json` — what a document loads as

Each row is `{ name, yaml }` (one document) plus exactly one of:

- `json` — the loaded tree. An expansion tag loads as its own mapping with the
  marker `__expand: "<tag>"` FIRST and the written keys after it, in written
  order; a `!ref` sentinel is `{ __tagged, engine: "ref", source }` plus the
  engine's `parsed` or `refusal`; `...` is a plain key. Compared as serialized
  JSON text, so key order is part of the answer.
- `refusal: { code }` — the loader refuses the document: an expansion tag on a
  scalar or a sequence, or a tagged mapping writing `__expand` itself.
  `BRANCH_SHAPE_INVALID` for `!if` / `!switch`, `REPEAT_SHAPE_INVALID` for
  `!for-each`.

No row holds an expression tag (`!cel`, `!interpolate`, `!sql`), which the Rust
loader refuses by name, and no row has an integer-like mapping key, whose order a
JavaScript object does not keep.

## `round-trip.json` — what a writer gives back (Node only)

Each row is `{ name, yaml }`, optionally `written`: parsing the text with the
custom-tag set and writing every document back gives `written` when present, the
text itself otherwise — every tag, its mapping, its key order and every `...`
key kept where written. `written` is used for one layout only: a whole document
behind a tag (`--- !switch`) is written with the tag on the line after `---`,
which the YAML library does for any tagged document and which means the same
document.

## `loader-positions.json` — what a loader refuses before building the graph

Each row is `{ name, yaml }` (a whole file) and `refusals`, a list of
`{ documentIndex, code }`: the expansion constructs written at a value the loader
itself reads before anything is expanded — a module document's `metadata` and
`metadata.name`, `imports:` (the block, an entry, an entry's `source`) and
`include:` (the block, an entry). `!if` / `!switch` there are
`BRANCH_POSITION_INVALID`, `!for-each` and a `...` splice
`REPEAT_OUTSIDE_TEMPLATE`. Every other position is judged by the analysis, not
the loader, so a row whose tags stand anywhere else expects no refusal. Run by the
two analyzers' loaders: `analyzer/nodejs/tests/loader-positions-conformance.test.ts`
and `analyzer/rust/tests/loader_positions_conformance.rs`.
