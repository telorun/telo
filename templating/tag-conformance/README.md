# Tag conformance vectors

What every manifest loader answers for the tags the templating layer owns — the
expansion tags (`!if`, `!switch`, `!for-each`), the `...` splice key and the
`!ref` grammar — and for the YAML beneath them: how scalars resolve, where each
field sits and how a malformed file is worded. Language-neutral rows; the data is
the artifact, the values are the Node loader's answers, and no generator is
committed. The Node loader runs them in `templating/nodejs/tests/tag-conformance.test.ts`,
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
- `refusal: { code }` — the loader reports the document's expansion tag as
  misused: one on a scalar or a sequence, or a tagged mapping writing `__expand`
  itself. `BRANCH_SHAPE_INVALID` for `!if` / `!switch`, `REPEAT_SHAPE_INVALID`
  for `!for-each`. The tree still loads, as `yaml` reads it.

Rows also pin the YAML the tags sit in, as the `yaml` package reads it: plain
scalars by YAML 1.2's core schema (`yes` is a string, `0x1F` and `0o17` integers,
`~` null), an explicit core tag (`!!str`, `!!int`) read by that tag's test, an
alias copying its anchor's value and `<<` a plain key. A row's YAML parses with no
error.

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

## `loader-positions.json` — what a loader refuses, and where every field is

Each row is `{ name, yaml }` (a whole file), `refusals` and optionally `documents`.

`refusals` is every error the loader reports for the file, in its order, each
`{ documentIndex, code, message, range? }`; `range` is `[startLine, startCharacter,
endLine, endCharacter]`, 0-based, characters in UTF-16 code units, absent where the
loader places none. Two families:

- the expansion constructs written at a value the loader itself reads before
  anything is expanded — a module document's `metadata` and `metadata.name`,
  `imports:` (the block, an entry, an entry's `source`) and `include:` (the block,
  an entry). `!if` / `!switch` there are `BRANCH_POSITION_INVALID`, `!for-each` and
  a `...` splice `REPEAT_OUTSIDE_TEMPLATE`, each at the range the position index
  gives its path. Every other position is judged by the analysis, not the loader,
  so a row whose tags stand anywhere else expects no refusal;
- YAML errors, `MANIFEST_PARSE_FAILED`, worded by Telo rather than by a parser: one
  closed set of kinds — a key written twice, an alias naming no anchor before it in
  its document, aliases expanding past `yaml`'s bound of 100, a quote never closed,
  a flow collection never closed, a tab as indentation, a plain value holding `: `,
  a line indented to match nothing beside it, an undefined escape, a plain value
  starting with `@` or `` ` `` — each with one sentence, and every other error as
  "not valid YAML". Both loaders read with one parser — the Rust one a twin of the
  `yaml` package's lexer, parser and composer at the version the Node packages pin
  — and place each of its errors in a kind by its code and, where one code covers
  several causes, its message, so a row holds every error of the file, in the
  loader's order: several in one document, and errors in later documents. Rows pin
  an input for each error code the parser raises, each branch of the placement,
  and inputs whose ranges depend on how far the parser reads on (a quote or a
  bracket left open as the document continues, a tab after a value). The alias
  bound's row sits exactly one alias past it, so a loader moving the bound by one
  fails it.

`documents`, when present, is each document's `{ sourceLine, positions }`: the
0-based line it starts on, and its position index — every field value's range
under its dotted path (`list[3].flow`) and every map key's under `@key:<path>`, in
the order the index files them, compared as text. A node's range runs from its
first character after its tag and anchor to the end of its own text; a block
collection ends where its last value ends, line break and the trailing comment
lines it keeps included; an alias is no entry. A span with no `---` marker, no
node and no error — what a leading `...` opens — is no document to either loader,
so the document after it is document 0.

Run by the two analyzers' loaders: `analyzer/nodejs/tests/loader-positions-conformance.test.ts`
and `analyzer/rust/tests/loader_positions_conformance.rs`.
