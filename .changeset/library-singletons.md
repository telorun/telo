---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
---

**Library singletons** — `lifecycle:` on a `Telo.Library` decides how many times
it is instantiated in one application. `isolated` (the default) is today's
behaviour: one child scope per import declaration. `shared` makes the library a
singleton every import resolves to, at any depth.

The field was declared on `Telo.Application` and read by nothing. It is the
other half of the problem `resources:` solves: that block hands ONE instance down
to several libraries, and this one lets several libraries reach ONE library that
owns an instance — without linearizing them into a chain that re-exports the
union of everything beneath it.

- **The root owns it; every import borrows it** — the same rule an injected
  resource follows. The child scope is spawned under the ROOT rather than under
  whichever import reached it first, because otherwise tearing that importer down
  would close a library two others still hold, and which importer that is depends
  on init order.
- **Torn down after every other root child.** `teardownPriority` is now a
  property of a CONTEXT as well as of a resource instance, and the child cascade
  sorts by it: a singleton registered during a nested import's init would
  otherwise be reverse-registration-ordered ahead of the library that borrowed
  it, so a borrower's inverse could run against a library already gone.
- **Initialization is memoized on the ENTRY, not on an import.** The import that
  REGISTERS a singleton is not necessarily the one whose `init()` runs first — a
  root import registers it during the create sub-phase, while a nested import
  inside another library borrows it during that library's init — so the builder
  travels with the registry entry and whoever gets there first runs it.
- **Every import of a singleton must agree**: different variables, secrets or
  resource instances names both aliases and the key that differs, never a
  secret's value. Reported at BOTH ends — `SHARED_LIBRARY_CONFLICT` at
  `telo check` wherever it is decidable there, `ERR_SHARED_LIBRARY_CONFLICT` at
  boot, which holds resolved values and live instances and is authoritative. The
  static half compares only what it can: a value holding a `!cel` is skipped
  (two expressions may evaluate equal, and identical text in two modules may
  not), and a reference is compared only between imports declared in the same
  module, since a bare name means the same instance only in one scope. It groups
  on the target's RESOLVED SOURCE — the identity the kernel keys its registry on
  — because `resolvedModuleName` would collapse two versions of one module.
  Resolving a conflict by init order would make the winner whichever import was
  created first, silently, which is the failure this feature removes rather than
  relocates.
- **A per-import `logging:` / `runtime:` override is refused** —
  `SHARED_LIBRARY_OVERRIDE` statically, `ERR_SHARED_LIBRARY_OVERRIDE` at runtime.
  Both scope a subtree that is no longer one import's subtree. A singleton's
  logging scope is the library's own module name for the same reason.
- **A second import costs nothing**: the registry is keyed on the resolved module
  URL and holds only shared libraries, so the hit IS the answer to "is this
  shared" — no fetch, no parse, no analysis pass.

Default `isolated` rather than `shared` — the opposite of the Application
field's — because flipping it would silently collapse every existing app's
resource graph and turn per-import `variables:` into a conflict. New syntax on a
module document, so a module using it must declare `requires: telo: ">=…"`.
