---
"@telorun/analyzer": patch
"@telorun/kernel": patch
---

Fix scope resolution for route handlers of an `Http.Api` (or any composer) that
is defined in a library and mounted/consumed by another module. The library's
inline `kind:` handlers and their `!ref`s are anonymous children of the
declaring document and now resolve against that library's import map rather than
the consumer's.

- Analyzer: top-level kind validation and throws-union/`catches:` coverage now
  resolve a resource's kind aliases in its own `metadata.module` scope (falling
  back to the consumer's), mirroring the existing nested-inline and reference
  paths. This removes false `UNDEFINED_KIND` and `UNBOUNDED_UNION_NEEDS_CATCHALL`
  diagnostics for imported-library handlers.
- Kernel: imported libraries now initialize their resources in dependency
  (topological) order, like the root context, so a dependent (e.g. an `Http.Api`
  whose inline handler is extracted to a sibling resource) no longer runs Phase 5
  injection before its dependency is created — which previously left the handler
  ref unresolved and produced `ERR_RESOURCE_NOT_INVOKABLE` at request time. A
  circular dependency purely among a library's own resources (invisible to the
  root graph) is now surfaced as `ERR_CIRCULAR_DEPENDENCY`, mirroring the root.
