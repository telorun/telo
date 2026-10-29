---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

A library whose manifest lies inside the directory of the module being published now ships inside that module's OCI artifact instead of as a separate sibling artifact. `telo publish` keeps its import relative and pinned (`./chat#sha256-…`), places its manifest in the parent's manifest layer and pushes its own layers into the parent's repository; an import leaving the root still points at a separate artifact. The runtime resolves such an import to `oci://<host>/<repo>@sha256:<parent digest>/<path>`, checks it against the pin and materializes it inside the parent's directory; `telo install` and `telo package` record the parent's digest in `.origins.json` and warm the nested layers. A library inside another module's directory imported from outside it is refused at publish (`import_nested`), and `telo release` refuses a workspace module that ships inside another. Digest-addressed cache entries are now spelled `sha256-<hex>` (Windows-safe), and a tag spelled like a digest is refused. The Rust kernel refuses a relative import inside an artifact with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.
