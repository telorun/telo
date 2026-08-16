# De-inline sibling modules

Sequenced after `plans/telo-release-versioning.md`. Not a prerequisite for it.

## Problem

A module's controller bundle inlines its sibling libraries: esbuild copies `@telorun/sql`'s source
into `sql-postgres`, `sql-sqlite` and `kv-store-sql`, and `@telorun/kv-store`'s into five more. Each
bundle therefore carries its **own copy of that library's module scope**, and that is a live
correctness bug rather than a size complaint — CLAUDE.md records it: "a module's controllers ship as
separate bundles each inlining its copy of a shared source file, so module scope is one copy per
bundle (that was the live `sql` bug: `transaction:` threw on every path)". `sql` keeps its executor
`WeakMap` on an injected connection instance today purely to work around it, which means every
future shared-state seam has to rediscover the same workaround.

A secondary effect: the same bytes ship many times over, and every dependent's payload moves
whenever a shared library changes.

## Solution

A **module-owned library becomes `--external`** and is resolved at load through the module import
graph, instead of being copied into each dependent's bundle. `BundleControllerLoader` already does
exactly this for `@telorun/sdk` — `REALM_COLLAPSE_NAMES` (`controller-loaders/realm.ts`) symlinks
one copy into a `node_modules/` beside the bundle, which collapses resolution *and identity*, so
`instanceof` holds across the boundary. The extension is where the copy comes from: the sibling
module's own artifact, named by the `imports:` alias that already declares the dependency, rather
than a copy the kernel happens to own.

Three pieces are missing today and this plan introduces them.

**A library layer role, with an entry-point locator.** `codec`, `http-dispatch`, `kv-store` and
`type` declare no controller at all — they have no `pkg:` candidate and so no JS layer for anything
to resolve against. The artifact spec (`kernel/specs/module-artifact.md`) gains a `library` layer
role alongside `manifest` / `controller` / `assets` / `common`, and the module doc gains a locator
naming its entry point, in the same PURL vocabulary `controllers:` uses — a bundled artifact format
plus a `path=`, so a library layer is selected, materialized and platform-matched by the machinery
that already does it for controllers. This also gives the four contract-only packages a reason to
stop publishing to npm, which the bundled-module migration otherwise left unfinished.

**A specifier→alias mapping, statically checkable.** A bundle imports the bare specifier
`@telorun/kv-store`; the manifest declares the dependency as `KvStore: ../kv-store`. Nothing
connects the two, and the existing realm collapse sidesteps the question by being a closed
kernel-owned list of one name. So the module doc declares the mapping explicitly — per import, the
specifier its controllers import that alias by — and the analyzer checks both directions: a
specifier declared but not imported, and an import resolved to no declared alias, are diagnostics
rather than a load-time "Cannot find module". Deriving the mapping from the esbuild metafile was
rejected: it would make a manifest's meaning depend on a build artifact, and the analyzer is
browser-safe and has no build to read.

**Deduplication is per (module, resolved version), and skew is stated.** The guarantee is not "one
copy per import graph" — the Merkle pin channel is deliberately retained by the release plan, so a
diamond where two dependents pin different versions of `sql` legitimately resolves two copies, and
two module scopes. That is correct behaviour, not a leak: they are different code. What must not
happen is it going unnoticed, so the loader reports a resolved-version skew for a shared library,
and `telo check` reports it statically from the pinned graph. A shared-state seam that requires a
single scope must therefore say so; the honest granularity is the pin, and pretending otherwise
would reinstate the bug this plan exists to fix, silently.

## Decisions

- **Only workspace modules are de-inlined.** Third-party dependencies (`kysely`, `pg`,
  `better-sqlite3`) and workspace packages that are not modules (`packages/glob`) have no module
  artifact to resolve against; inventing one for `kysely` would be building a package manager.
- **The mapping is declared in the manifest, not derived from the build.** It has to be checkable
  by a browser-safe analyzer with no build to inspect, and a manifest whose meaning depends on a
  build artifact is not statically analyzable.
- **The library layer reuses the controller locator vocabulary** rather than adding a second one, so
  selector matching, lazy materialization and platform fallthrough are inherited whole.
- **A module artifact stops being self-contained, and that cost is accepted.** Controller loading
  gains an ordering dependency on the import graph being materialized first, which bundling had
  removed. The correctness bug outranks it, and materialization is already lazy and cached.
- **The property is JS-only for now.** A Rust controller cannot import a JS module's layer, so a
  Rust-side sibling library keeps inlining until the equivalent exists there. Stated rather than
  designed around, because the reverse — holding the fix until both runtimes can share it — leaves
  a known-broken shared-scope seam in place indefinitely.
- **Sequenced after the release system, not merged into it.** Once siblings are external, a
  dependent's payload no longer moves when its dependency changes, so propagation shifts off the
  payload digest and onto the `imports:` edge graph. That is a change to the release model's spine
  and needs the release model to exist, and to be trusted, first.
