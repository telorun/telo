---
"@telorun/kernel": patch
---

fix(kernel): version-scope controller installs and fully warm the validator cache so read-only (k8s) boots write nothing

Two "green install, red run" defects surfaced when running a baked image on a
read-only rootfs (the k8s runner), where any post-`telo install` write is fatal
(`EROFS`):

- **Version collision in the flat install root.** When a manifest graph
  referenced the same controller npm package at two versions (e.g. an app using
  `@telorun/mcp-client@0.4.0` directly while an imported library pins `0.3.1`),
  the single flat `node_modules` could hold only one — the last `npm install
  --save` clobbered the other. At runtime the definitions pinned to the missing
  version failed the install fast-path and fell into `withInstallLock`, writing
  `<root>/.lock` and aborting the boot. Each `name@version` is now installed
  under a distinct npm alias (`npm install <alias>@npm:<name>@<version>`), so all
  versions coexist in one install root — mirroring the per-`(name, version)`
  identity of a Telo module singleton, and how npm/cargo/go coexist incompatible
  versions. `@telorun/sdk` stays exempt (real name, single hoisted copy) so
  realm-collapse is unaffected.

- **Validator cache under-warmed.** `telo install`'s analyze-only warm compiled
  only the static-analysis validators, so the runtime recompiled every
  per-resource config validator during instantiation and failed to persist them
  read-only (noisy `validator cache write failed` on stderr). The warm pass now
  pre-compiles every `Telo.Definition` schema (from the static manifests) plus
  the framework/builtin controller schemas (from the registry). The validator
  cache *key* also normalizes CEL/template sentinels to their original `source`,
  so a schema that embeds `!cel`/`!sql` tags (in `examples`, `description`, or
  anywhere else) hashes identically whether it arrived as parse-time
  `{__tagged}` sentinels (build-time warm, raw analysis graph) or compile-loader
  `{__compiled}` values (runtime). Only the key is normalized — AJV still
  compiles the full schema, and structural keys are never dropped, so a property
  literally named `description`/`examples` keeps its own schema in the key.
