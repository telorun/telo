---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
"@telorun/sdk": minor
"@telorun/http-server": minor
"@telorun/mcp-client": minor
"@telorun/assert": minor
"@telorun/test": minor
---

Layered module artifacts: a published module is now one artifact of several layers instead of one tarball, and each layer is materialized only when something needs it.

`telo.yaml` gets its own layer, so reading a manifest no longer downloads (and discards) the whole payload. The rest of `files:` is partitioned into one layer per bundled-controller selector — `format` plus optional `os`/`arch`/`libc` PURL qualifiers — plus an `assets` layer for what the new optional `assets:` list claims and a `common` layer for everything else. A Node kernel never fetches a `napi` layer, a `linux/amd64` host never fetches the `darwin/arm64` binary, and an app that imports a module for its API alone never fetches its frontend.

This fixes a cold-start failure: bundled controllers used to resolve against an `oci://` base URI that was read as a filesystem path, because the payload was written to disk by a CLI hook running *after* `kernel.load()`. The first run of any OCI-imported module with bundled controllers failed and the second succeeded. Controller layers now materialize at resolve time through a module-scoped `ModuleArtifact`, built during load where the pinned import ref and the verified manifest are both available — so verification stays anchored to the importer's `#sha256-` pin rather than to whatever is in the cache.

`ctx.resolveModuleFile(relative)` is the new, URI-returning way to reach a file that ships with a module; it materializes the asset layer on first use. `Http.Static`, `mcp-client`, `assert`'s manifest loader and `Test.Suite` all use it, which also fixes a silent bug where a non-`file://` module resolved a relative root against the process working directory and served the wrong directory instead of failing.

Also: `telo install --platform os/arch[/libc]` pre-fetches layers for a platform other than the build machine's, the layer index and selector grammar are specified normatively in `kernel/specs/module-artifact.md`, and the cross-process cache lock is shared between the npm loader and layer materialization instead of duplicated.

Modules published before layers keep resolving: the manifest read path still accepts a single-blob artifact, which contains `telo.yaml` — so nothing that ships no payload needs anything done to it, and npm-backed modules are entirely unaffected. What such an artifact cannot supply is a layer index, so a module that *does* ship a payload resolves its manifest and then fails at the controller with an actionable "republish" error. That is the six modules shipping `files:` — `oauth-client`, `scheduler`, `kv-store-memory`, `kv-store-redis`, `kv-store-sql`, `idempotency` — which must be republished, with consumers bumping to the new versions.
