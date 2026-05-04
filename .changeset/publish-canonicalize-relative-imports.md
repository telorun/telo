---
"@telorun/cli": patch
---

`telo publish` now canonicalizes relative `Telo.Import.source` paths (e.g. `../ai`) into absolute registry references of the form `<namespace>/<name>@<version>` before pushing the manifest. Relative paths are only meaningful on the publisher's filesystem; once a manifest reached the registry, the leading `..` collapsed the version segment of the registry URL (so e.g. a sibling import at `…/<package>/<version>/` + `../<sibling>` resolved to `…/<package>/<sibling>`, dropping the version), and any consumer that imported a published library which itself used relative imports got a 500 from the registry. Sibling-module metadata (`namespace` / `name` / `version`) is read from the local target's `telo.yaml` at publish time.
