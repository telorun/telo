---
"@telorun/sdk": minor
---

`ResourceContext.resolveDeclaredManifest(name, alias?)` — the manifest a name was DECLARED with, resolved in the context that owns the resource. The counterpart to `resolveRef` for a slot that wants a fact about its target rather than the target itself: a declaration is readable whether or not the resource has been constructed, so such a slot needs no ordering edge and can name the resource reading it. The kernel already implemented it; only the interface withheld it from module authors.
