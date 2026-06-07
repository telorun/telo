---
"@telorun/kernel": patch
---

Resolve `!ref` sentinels inside imported `Telo.Library` resources. The
import-controller registered a library's runtime manifests without running the
normalization pass the root load performs, so a `!ref` between two resources in
the same library (e.g. `Sql.Migrations.connection: !ref Db`) reached its
controller as a raw `{__tagged, engine: "ref", source}` sentinel and Phase-5
injection silently skipped it. The controller now normalizes child manifests in
the library's own alias scope before registering them, threading the
analysis-flattened graph as cross-module resolution targets so a library that
references its own sub-imports' exports (`!ref SubAlias.name`) resolves too.
