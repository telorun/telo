# Built-in vocabulary

One JSON file per built-in document, and one per shared schema fragment under
`fragments/`, read as one lexically ordered set. The **built-in vocabulary** is
every kind a manifest names without an import — `Telo.Application`,
`Telo.Library`, `Telo.Definition`, `Telo.Abstract`, `Telo.Import`,
`Telo.NeedType`, `Telo.JsonSchema`, `Telo.Function`, the sinks, the capability
abstracts, the public-address need types — plus the fragments a schema points at
with `$ref: "telo://manifest#/$defs/<Name>"`.

The files live **here**, beside the language halves rather than inside either,
because the Node analyzer, the Rust analyzer, both kernels and the editor support
all read this one vocabulary, and a copy written as one language's code would be
a second vocabulary drifting silently. JSON because it is the only format all
three runtimes embed with no generation step.

`scripts/render-builtin-vocabulary.mjs` (the root `prepare` and
`@telorun/analyzer`'s own) derives the entries and writes them, as literals, into
the barrel `analyzer/nodejs/src/builtin-entries/index.ts`, built from the
directory listing, so a file that exists always registers. From the same
derivation it renders the release's `Telo.Builtins` archive — these documents,
the fragments, `sdk/value-types/`, `sdk/zone-attributes/` and `sdk/formats/` in
one YAML stream, `kernel/specs/builtin-vocabulary.md` — which `telo builtins`
prints and every release publishes as `oci://ghcr.io/telorun/telo@<version>`. A
name the archive selects by (a kind's name, a fragment's, a value type's, a zone
attribute's, a format's) must select one entry; the renderer refuses two. The Rust analyzer
embeds the documents with `include_str!` (`analyzer/rust/src/builtins.rs`), and a
test holds its list to this directory.

## A document

Each file is the built-in **in its authored form**, named `<metadata.name>.json`:

- `kind` is `Telo.Abstract`, `Telo.Definition` or `Telo.NeedType`, and
  `metadata.name` the kind's name without its `Telo.` prefix. No document names a
  module: the vocabulary is the module `Telo`.
- `metadata.description` is search text, written for a reader who does not yet
  know the kind exists (the root `CLAUDE.md`'s description rules).
- **No document carries `controllers:`** — the kernel implements every kind here.
  The Node analyzer marks each `Telo.Definition` whose capability is a declarable
  role as kernel-implemented when it registers it.
- A fragment reference stays a reference (`$ref: "telo://manifest#/$defs/Step"`);
  expanding it is the analyzer's. A definition that `extends` another built-in
  declares only its own fields.

## The capability roster

A capability names a lifecycle a kernel implements, so the set is closed and no
module can add one. The **roster** is the `Telo.Abstract` documents carrying
`declarable`:

| key             | meaning |
| --------------- | ------- |
| `capability`    | The entry's own name for a **role** (`Telo.Service` declares `capability: Telo.Service`). Absent for an entry that is no role — `Telo.Executable`, a slot constraint. |
| `declarable`    | An authored `capability:` may name it. `false` for `Telo.Template` (the role of the built-in document kinds) and `Telo.Executable`. |
| `throwsAllowed` | A kind of this role may declare `throws:` — its dispatch returns to a caller who can catch. |
| `metadata.description` | What the role is. The editor shows it on hover, and `CAPABILITY_NOT_DECLARABLE` quotes it. |

## Derived lists

Two lists are written as a marker and derived from the roster, never written out:
`{ "$roster": "declarable" }` becomes the sorted names of the declarable roles,
and `{ "$roster": "throwsAllowed" }` the sorted names of the roles whose
`throwsAllowed` is true. The `Telo.Definition` and `Telo.Abstract` documents use
them for the `capability:` enum and for the roles a `throws:` block is legal on.
The renderer refuses an unknown flag; a reader refuses a marker left underived.

## A fragment

`fragments/<Name>.json` holds the fragment's JSON Schema body, verbatim; the file
name is the name under `telo://manifest#/$defs`. A fragment refers to another —
and a recursive one to itself — as `telo://manifest#/$defs/<Name>`, the spelling an
author writes. Which fragments recurse is derived from those references.

A recursive fragment cannot be expanded in place, so a reference to one is rewritten
to a document-local `#/$defs/telo:<Name>` with one copy hoisted into the ROOT of the
author-written schema holding the reference: a document's top-level schema-valued
key, or a position a built-in entry declares as a schema fragment (directly or as a
union branch) — a parameter's `schema`, a result's, a need type's `parameters` and
`fields` values. Those positions are derived from these entries, so a built-in that
gains a schema slot makes it a root with no change to the reader.
