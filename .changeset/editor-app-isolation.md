---
"@telorun/editor": patch
---

Isolate each application's static analysis so apps in a workspace no longer
interfere with one another. Previously the whole workspace was analyzed against
a single shared registry keyed by module name, so when two apps imported the
same library at different versions, one version's definitions overwrote the
other's — producing spurious diagnostics and wrong completions for the losing
app. Analysis now runs per-application closure with an isolated registry, and
the source-view completion provider selects the registry of the active module.
Diagnostics are also now routed to each resource's own source file via the
analyzer's stamped `filePath`, so two modules that legitimately share a
`{kind, name}` (resource names are module-scoped) no longer misattribute one
module's diagnostics to the other.
