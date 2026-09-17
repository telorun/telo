---
"@telorun/cli": minor
"@telorun/ide-support": minor
---

`telo cel functions <manifest>` lists, ahead of the catalog, the module functions that manifest can call — its own through `Self` and each import's exported ones through the alias — with their signature, description and derived determinism, naming the chain to a non-deterministic or host-backed leaf. Under `--json` each is an entry of category `module` carrying `deterministic`, `hostBacked`, `nondeterministicVia` and `hostBackedVia` wherever the analysis derived them, and none of the four where it did not. The manifest is loaded exactly as `telo check` loads it — through the `.telo/manifests` cache, with mutable `oci://` tags revalidated — and one that does not load, or that analysis reports errors in, is refused on stderr, each error located, with a non-zero exit. `@telorun/ide-support` exports `functionSignature`, the one rendering of a function's signature every surface shares.
