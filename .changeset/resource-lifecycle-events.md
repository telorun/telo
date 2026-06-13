---
"@telorun/kernel": minor
---

Emit symmetric resource lifecycle events during init. Each resource now emits
`<Kind>.<Name>.Created` after its instance is constructed and
`<Kind>.<Name>.Initialized` after `init()` + `snapshot()` complete, mirroring the
existing `<Kind>.<Name>.Teardown`. The debug event stream previously showed only
teardown for individual resources, never their creation/initialization.

The `Created` event advertises the resource — `{ resource: { kind, name, module },
dependencies: [{ kind, name, alias? }] }` — where `dependencies` are the resolved
`!ref` targets in the resource's config. This is the data a debug-UI resource
graph is built from.
