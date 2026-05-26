---
"@telorun/analyzer": minor
---

Static analyzer now catches two classes of bugs that previously surfaced only at kernel boot or request time.

- **`DUPLICATE_RESOURCE_NAME`** — emitted when two non-system resources share a `metadata.name` (e.g. `Telo.Application HelloApi` and `Http.Api HelloApi`). The kernel's resource registry uses a single namespace across non-system kinds and rejects collisions at boot with `ERR_DUPLICATE_RESOURCE`; the analyzer now matches that behaviour so `pnpm run check` surfaces it.

- **Fixes a silent bypass in object-form `{kind, name}` reference validation.** A `Telo.Application` (or `Telo.Library`) declared without a `metadata.namespace` was overwriting the registry's built-in `"telo"` identity (`registerModuleIdentity(null, moduleName)` in `definition-registry.ts`). As a result, every `x-telo-ref` keyed off `"telo#…"` (e.g. `Http.Api.routes[].handler`'s `"telo#Invocable"`) resolved to a nonexistent `<UserApp>.<Capability>`, the kind-mismatch check short-circuited on partial context, and the analyzer reported zero issues for manifests that exploded at runtime with `ERR_RESOURCE_NOT_INVOKABLE`. User-level modules without a namespace no longer claim that built-in identity.

Together these two changes turn the canonical "`kind: JavaScript.Script`-when-the-alias-is-`JS`" mistake into a clear static `REFERENCE_KIND_MISMATCH` diagnostic instead of a runtime crash.

New regression coverage at `analyzer/nodejs/tests/duplicate-and-bad-alias.test.ts`.
