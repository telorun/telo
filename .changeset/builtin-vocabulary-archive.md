---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

The built-in vocabulary of a release is a document you can read. Every telo release renders it as a `Telo.Builtins` YAML stream (`kernel/specs/builtin-vocabulary.md`): a root carrying every shared schema fragment, value type, zone attribute and string format, then one document per built-in kind in its authored form. `@telorun/analyzer` ships it as `src/builtin-vocabulary/builtins.yaml`, with its MIT `LICENSE` beside it, exports the same bytes as `BUILTIN_VOCABULARY_ARCHIVE`, and refuses to pack unless the archive carries exactly the package's version. `telo builtins` prints it, and `telo builtins Application Step Telo.Url` prints only those entries; an unknown name exits 1 listing every name there is. `@telorun/analyzer` also exports the archive's reader (`readBuiltinVocabulary`) and the selection both CLIs print with (`selectBuiltins`, `builtinVocabularyEntries`).

The archive is read, never run, declared or imported: as the entry of `telo check` / `telo run` it is one `UNDEFINED_KIND` saying what it is, and an import of it is `INVALID_IMPORT_TARGET` telling you its kinds need no import. `telo publish` accepts a `Telo.Builtins` root as a manifest-only artifact — no module analysis runs, the archive's own reader refuses a malformed one, and the published `telo.yaml` is the archive's bytes with only the `layers:` index appended — and `telo module manifest --json` reports one with `runtime: null` and `application: null`. Every release is published as `oci://ghcr.io/telorun/telo@<version>`.

`Telo` and `Self` are reserved: a module named either, an import aliased either, and an import reaching a library named either are refused as `KIND_PREFIX_RESERVED` by `telo check` and `ERR_KIND_PREFIX_RESERVED` by both kernels. This is a breaking change: a library named `Telo` used to be accepted and silently replaced the built-in definitions.
