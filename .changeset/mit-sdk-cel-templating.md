---
"@telorun/cel": minor
"@telorun/sdk": minor
"@telorun/templating": minor
"@telorun/cli": minor
---

`@telorun/cel`, `@telorun/sdk` and `@telorun/templating` are released under the MIT License from this version, and a published module carries its own license text.

The three packages declare `"license": "MIT"` and ship the MIT text; their Rust twins (`telorun-sdk`, `telorun-sdk-core`, `telorun-sdk-macros`, `telorun-abi`, `telo-templating`) declare `license = "MIT"`. The analyzer, kernel, CLI and editor packages stay under the Sustainable Use License, and versions already published keep the license they shipped with.

`telo publish` and `telo package` now carry a `LICENSE` file at a module's root with no `files:` entry: it ships in the artifact's `common` layer, beside the notices a `sources:` entry names. A module that keeps a `LICENSE` beside its `telo.yaml` therefore publishes one more file than before, which moves the pin of its published `telo.yaml` — republishing such a module at a version that is already published is refused, and needs a new `metadata.version`.
