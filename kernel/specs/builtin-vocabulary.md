---
description: "Normative: the Telo.Builtins archive — the built-in vocabulary of one telo release as a YAML stream: its root and documents, the byte layout every reader slices, what refuses it, telo builtins, and its publication as oci://ghcr.io/telorun/telo."
---

# The built-in vocabulary archive

Normative. The kinds a manifest names without an import — `Telo.Application`,
`Telo.Library`, `Telo.Definition`, `Telo.Abstract`, `Telo.Import`, `Telo.NeedType`,
`Telo.JsonSchema`, `Telo.Function`, the sinks, the capability roles, the public-address need
types — and the shapes they share are the **built-in vocabulary**. Its source is the data under
`sdk/builtins/` (`sdk/builtins/README.md`); this document specifies the form one telo release
renders it in, publishes it in and prints it in. The Node reference is
`scripts/render-builtin-vocabulary.mjs` (rendering), `readBuiltinVocabulary` (reading) and
`selectBuiltins` (slicing), both in the analyzer.

## 1. The document

A YAML stream. The first document is the **root**; every later document is one built-in kind.

1. The root is `kind: Telo.Builtins` with `metadata`:
   - `name: Telo` — the vocabulary is the module every `Telo.<Kind>` names;
   - `version` — the telo release whose vocabulary this is: `X` for a release, `X+unreleased`
     for a build of a tree whose release is still pending;
   - `description` — search text;
   - `license: MIT`.
2. The root carries five sections, each a map keyed by name:
   - `$defs` — every shared schema fragment, unexpanded. A fragment refers to another as
     `$ref: telo://manifest#/$defs/<Name>`. No key starts with `telo:` (that prefix is the
     analyzer's for a fragment it hoists into a schema). Eight of them are the grammar of the
     expansion tags' own mappings — `IfValue`, `IfDeclaration`, `SwitchValue`,
     `SwitchDeclaration`, `ForEachValue`, `ForEachEntry`, `ForEachDeclaration`,
     `ForEachStepRepeat` — each the closed key set of one tag at one kind of position, marker
     excluded; no schema references them, and a reader holds a tag's keys to the one its
     position selects.
   - `valueTypes` — every value type, keyed by its `name` (`Telo.Url`), each entry its data
     file verbatim (`sdk/value-types/`).
   - `zoneAttributes` — every zone attribute, keyed by its `name` (`noSuspend`), verbatim
     (`sdk/zone-attributes/`).
   - `formats` — every Telo string format, keyed by its `name` (`css-selector`,
     `language-tag`, `message-pattern`), verbatim (`sdk/formats/`).
   - `errorCodes` — every error code the runtime raises around every dispatch alike, keyed by
     its `code` (`ERR_INPUT_INVALID`), verbatim (`sdk/error-codes/`): its `description`, the
     `displayMessage` a person is shown for it, written in English, and an optional `data`
     schema.
3. Every later document is a built-in in its authored form: `kind` is `Telo.Abstract`,
   `Telo.Definition` or `Telo.NeedType`, and no document carries `controllers:` — the root's
   kind says once that the runtime implements every kind in the archive. A fragment reference
   stays a reference; the two lists derived from the capability roster (the `capability:` enum
   and the `throws:` allowlist) are written out, so the archive states which capabilities are
   legal.
4. **Closure.** Every `telo://manifest#/$defs/<Name>` the archive holds names an entry of
   `$defs`; every `x-telo-type` — and every type argument naming one — an entry of
   `valueTypes`; every zone attribute an entry of `zoneAttributes`; every `format:` that is no
   JSON Schema format an entry of `formats`. A reader of one release's archive needs no other
   source.
5. Neither the `x-telo-*` annotation vocabulary nor the CEL function catalog is in the archive:
   an annotation's meaning is its reader's behaviour, and no definition names a function.

## 2. Layout

The archive is rendered by one fixed emitter, so its bytes are a function of the vocabulary and
the version alone. Every reader that slices it relies on this layout:

1. UTF-8, LF line endings, a trailing newline, no tabs, anchors, tags or comments.
2. Documents are joined by a line holding exactly `---`; the root comes first, then one
   document per built-in in the lexical order of their entry files.
3. Block style with a two-space indent. A map's keys keep their source order; the keys of each
   root section are in lexical order. An empty map or list is written `{}` / `[]`.
4. Every document starts with a `kind:` line, then a `metadata:` line whose first key is
   `name:`.
5. A string, and a key, is written plain when it starts with a letter, `_` or `$`, continues
   with letters, digits and `_ $ . / -`, and is not one of `true false null yes no on off y n ~`
   in any case; otherwise it is written as a JSON string. No value spans more than one line.
6. A root section is a line at column 0 ending in `:`; each of its entries is a line at column
   2 ending in `:`, followed by the entry's body, every line of it indented further. A section
   with no entry is written `<section>: {}`.

## 3. Refusals

`Telo.Builtins` is read, never declared, run or imported. It is registered nowhere, so each
way of using it as a module is refused:

| Use | `telo check` | Node kernel | Rust kernel |
|---|---|---|---|
| A file whose first document is `Telo.Builtins`, as the entry | one `UNDEFINED_KIND` at its `kind:` line, and nothing else from that file | `ERR_MANIFEST_VALIDATION_FAILED` carrying it | `ERR_MANIFEST_VALIDATION_FAILED` |
| A document of that kind in a module file | `UNDEFINED_KIND` | `ERR_MANIFEST_VALIDATION_FAILED` carrying it | — |
| An import whose target is an archive | `INVALID_IMPORT_TARGET` at the `imports:` entry | `ERR_INVALID_IMPORT_TARGET` carrying it | `ERR_INVALID_IMPORT_TARGET` |

The entry's and the document's message is *"Telo.Builtins is the published built-in vocabulary
of a telo release; it is read, never declared, run or imported."* The import's is *"'<source>'
is the built-in vocabulary of telo <X>; its kinds need no import — remove this `imports:` entry
and write them as `Telo.<Kind>`."*, `<X>` being the archive's `metadata.version` (*"a telo
release"* when it declares none).

## 4. `telo builtins [<name>…]`

Both CLIs print the archive of the telo they are, through their output seam, and never render
it: the Node CLI prints the bytes `@telorun/analyzer` exports as `BUILTIN_VOCABULARY_ARCHIVE`,
and the Rust CLI embeds the same file at build, refusing to build without it.

1. With no name, the archive is written byte for byte.
2. Each name selects one entry. A kind or need type is selected by its name with or without
   `Telo.` (`Application`, `Telo.Application`) and prints its whole document. A fragment
   (`Step`), a value type (`Telo.Url`), a zone attribute (`atomic`), a format
   (`css-selector`) or an error code (`ERR_INPUT_INVALID`) prints its section's line followed
   by the entry's line and body. No name
   selects two entries; the renderer refuses an archive in which one would.
3. Several names print their entries in argument order, joined by a line holding `---`.
4. A name that selects nothing writes nothing to stdout, writes *"No built-in is named
   '<name>'[, '<name>'…]. The names are:"* followed by one line per class listing every name of
   it, and exits 1.
5. Under the Node CLI's `-o json` the same bytes are written as one JSON string.
6. There is no version flag. Another release's vocabulary is
   `telo module manifest oci://ghcr.io/telorun/telo@<X>`; `--json` reports it with
   `runtime: null` and `application: null`.

## 5. Publication

Every telo release `X` at or above the first that ships the archive is published as
`oci://ghcr.io/telorun/telo@X`.

1. `@telorun/analyzer@X` carries the archive at `src/builtin-vocabulary/builtins.yaml`, with
   `sdk/LICENSE` beside it as `LICENSE`; the package refuses to pack unless the archive's
   version is exactly `X`.
2. `telo publish` accepts a `Telo.Builtins` root as a manifest-only artifact: it runs no module
   analysis and refuses (`manifest_invalid`) an archive `readBuiltinVocabulary` reports a
   problem with, one already carrying a `layers:` index, one whose version is a build of an
   unreleased tree, and one with no `LICENSE` beside it. Its only other layer is `common`,
   holding that `LICENSE`.
3. The published `telo.yaml` is the archive's bytes with a `layers:` block appended at the end
   of the root document, nothing else changed: removing that block gives back the archive in
   `@telorun/analyzer@X` byte for byte. The pin gate applies, so a second push of `X` with
   different bytes is refused.
4. The publish workflow reconciles on every push to main: for each released `X` whose tag is
   missing, it publishes the directory taken out of `@telorun/analyzer@X`'s tarball with the
   checkout's CLI. There is no backfill below the first release that ships the archive.
