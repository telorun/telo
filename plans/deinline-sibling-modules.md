# De-inline sibling modules

Builds on `plans/telo-release-versioning.md`, which has landed.

## Problem

A controller bundle inlines every source it reaches, so **module scope is one copy per bundle**.
That duplication happens twice over, and only the second half is about siblings:

**Within one module.** `modules/sql` declares six controller entry points — `Sql.Query`,
`Sql.Command`, `Sql.Transaction`, `Sql.Selection`, `Sql.Migration`, `Sql.Migrations` — and each is
bundled separately, so each carries its own copy of `sql-connection-base.ts`, `sql-run.ts` and the
whole kysely tree. This is the live bug CLAUDE.md records: "a module's controllers ship as separate
bundles each inlining its copy of a shared source file, so module scope is one copy per bundle (that
was the live `sql` bug: `transaction:` threw on every path)". `cache` has three entry points,
`oauth-client` seventeen; the shape is every multi-kind module's.

**Across modules.** esbuild copies `@telorun/sql`'s source into `sql-postgres`, `sql-sqlite`,
`kv-store-sql` and `vector-store-pgvector`, and `@telorun/kv-store`'s into six more. Every dependent
gets its own scope of a library the dependency owns.

`sql` keeps its executor `WeakMap` on an injected connection instance today purely to work around
the first, which means every future shared-state seam has to rediscover the same workaround.

A secondary effect: the same bytes ship many times over, and every dependent's payload moves
whenever a shared library changes.

## Solution

### One bundle per module

A module builds **one JS bundle**, and each `Telo.Definition` selects its controller out of it by
the PURL fragment the loader already projects:

```yaml
controllers:
  - pkg:telo/local/js?path=./nodejs/sql.mjs&local_path=./nodejs/src/index.ts#SqlQueryController
```

No new manifest surface: `#fragment` names an export today, and "omit it and the whole bundle is the
controller" is existing behaviour. The module's `src/index.ts` becomes the single entry and exports
its controllers alongside its shared surface.

Chosen over a self-referential specifier — `sql`'s own controllers importing `@telorun/sql` and
externalizing it — because that only makes the single scope *avoidable*: an author who writes
`./sql-connection-base.js` instead silently gets a second copy back, and nothing catches it. One
bundle makes it **unrepresentable**, there being no second module graph to hold a second copy.

The cost is that laziness becomes per module rather than per kind: a manifest using only `Sql.Query`
now evaluates `Sql.Migrations`' code too. In bytes and import time it is still a reduction — six
copies of kysely become one — but the granularity genuinely changes.

### A module-owned library is external

A library a sibling module owns becomes `--external` and is resolved at load through the module
import graph, instead of being copied into the dependent's bundle. `BundleControllerLoader` already
does exactly this for `@telorun/sdk` — `REALM_COLLAPSE_NAMES` (`controller-loaders/realm.ts`)
collapses resolution *and identity* by pointing one copy at the kernel's own. The extension is where
the copy comes from: the sibling module's own artifact, named by the `imports:` alias that already
declares the dependency.

Because a module's bundle is also its library entry, `sql-postgres` resolving `@telorun/sql` lands on
the same file `sql`'s own six kinds run from. **Exactly one `sql` scope in the process**, module-wide
and graph-wide.

### The library layer

`codec`, `http-dispatch`, `kv-store` and `type` declare no controller at all, so they have no
candidate and no layer for anything to resolve against. A library declares its entry point under
`exports:`, beside the kinds and instances it already exports:

```yaml
exports:
  kinds:
    - Connection
  code:
    - specifier: "@telorun/sql"
      format: js
      path: ./nodejs/sql.mjs
      source: ./nodejs/src/index.ts
```

**Under `exports:` because that is what it is** — a third surface crossing the module boundary,
gated the same way (a specifier nobody declares resolves to nothing). A top-level `library:` key on
a `Telo.Library` doc used the same word as the kind one line above it for an unrelated thing.

**Data, not a package URL.** `controllers:` needs a PURL to be able to name an ecosystem fetch
(`pkg:npm`, `pkg:cargo`); this entry never fetches — it names a file the module already ships — so
`pkg:telo/local/` would be constant segments before the first real datum, and a query string is one
opaque box to the visual editor. `format` plus the optional `os` / `arch` / `libc` build the same
`ArtifactSelector` a controller candidate does, so selector matching, lazy materialization and
platform fallthrough are inherited whole. `format` is explicit rather than inferred from the file
extension: a `.mjs` can be wasm glue, and an inference rule is one every other runtime's reader
would have to copy exactly.

**The specifier is declared by the library, once.** It is a property of the library — its name in a
host ecosystem — not of the relationship, so N consumers cannot disagree about it and adding a
consumer restates nothing. Sitting beside the format keeps runtime **derived, never declared**: the
entry says `format: js`, and a future Rust entry carries `specifier: telorun-sql` without a
runtime-keyed map anywhere.

**One specifier, one entry point — subpaths are not represented.** Reproducing npm's `exports` map
inside the artifact would pull a package manager's resolution semantics into Telo, which is what the
`kysely` decision below refuses on the same grounds. `@telorun/ai/content|types|redact` collapse to
`@telorun/ai` at their three call sites.

### Nothing is silently re-inlined

Three checks, each where the information actually is. Deriving the mapping itself from an esbuild
metafile was rejected — it would make a manifest's meaning depend on a build artifact, and the
analyzer is browser-safe with no build to read — but *verifying* it needs the sources, so that half
lives in the builder, which the run path and the publish path share.

- **The analyzer** validates the `exports.code:` block from manifest text alone: entry shape,
  selector qualifiers, a missing `specifier=`, two candidates claiming one format. An unreadable
  candidate names no entry point, so a consumer's bundle silently falls back to inlining — on
  someone else's machine.
- **The builder** rejects a bundle whose metafile inputs reach a declared sibling library's
  **entry-source directory** by any route other than its specifier, and rejects a subpath import of
  one. The tree is the entry source's directory, never the module's: a module directory holds its
  tests, and a fixture module nested inside one is a different module whose bundle is its own.
- **The builder also rejects an UNDECLARED library**, which is where the mistake is actually made: a
  module whose TypeScript imports `@telorun/sql` while its manifest never says `Sql: ../sql`. The
  first two checks are derived from the `imports:` edges, so they are vacuous exactly there —
  nothing externalizes the specifier, the package manager resolves it, and the duplicated scope
  returns with nothing to report it. Detection needs no workspace registry: an input that is neither
  under this module's own root nor inside a `node_modules` tree belongs to some other module, and
  the nearest enclosing `telo.yaml` says which.

### Deduplication is per (module, resolved version), and skew is stated

The guarantee is not "one copy per import graph". Two things break it legitimately, and both are
stated rather than papered over.

The Merkle pin channel is deliberately retained, so a diamond where two dependents pin different
versions of `sql` resolves two library layers, and two module scopes. That is correct — they are
different code — and what must not happen is it going unnoticed, so the kernel **warns** when one
specifier resolves to two modules in a graph. A warning, never an error: a shared-state seam that
requires a single scope has to say so, and the honest granularity is the pin. (`telo check` does not
report this today. It would need the joined view the kernel builds at load — import edges × each
target's `exports.code:` block — which the flattened analysis does not carry.)

An **npm-delivered controller is outside the seam entirely**: `sql-sqlite` resolves `@telorun/sql`
from its own tarball, so that copy is a second scope. Nothing reports it — the kernel would have to
read inside another delivery mode's package to know — and it closes when that module is bundled.
Until then a shared-state seam must not assume one scope, which is why `sql` keeps its executor
`WeakMap` on the connection instance.

## Artifact spec deltas

`kernel/specs/module-artifact.md`:

- **§1 roles** — a `library` role joins `manifest` / `controller` / `assets` / `common`: zero or
  more, one per selector, holding the entry point a sibling resolves a specifier to.
- **§3 index** — "controller **and library** layers carry a selector; `assets` and `common` are
  singletons". Per format for the same reason a controller layer is; a singleton would be wrong the
  moment a Rust library layer exists.
- **§1.1 sink** — a file claimed as both a controller entry and a library entry is placed in the
  **library** layer, the weaker precondition: a consumer must reach it without loading this module's
  controllers.
- **§5.1 materialization** — materializing a code layer for a selector materializes **both roles plus
  `common`**, so a candidate is found whichever role holds its file and a library entry's undeclared
  sidecar is on disk. Same shape as the existing "common rides along" rule.

Keeping only `controller` and letting the locator point into it was rejected: `kv-store` has no
controller, so that ships a "controller layer" containing no controller — a role that lies about its
contents.

## Scope

**Library layers** (a sibling imports their source at runtime): `sql` ← `sql-postgres`,
`kv-store-sql`, `vector-store-pgvector` (`sql-sqlite` imports it too but is `pkg:npm`-delivered, so
it resolves its own copy from npm) · `kv-store` ← `kv-store-memory`, `kv-store-redis`,
`kv-store-sql`, `lease`, `idempotency`, `oauth-client` · `cache` ← `cache-memory`, `cache-redis`,
`rate-limit` · `ai` ← `ai-openai`, `ai-mcp` · `vector-store` ← `vector-store-memory`,
`vector-store-pgvector` · `embedding` ← `embedding-openai`.

**No library layer today:** `http-dispatch` (its only importer, `http-server`, is `pkg:npm`-delivered
and resolves it from npm), `codec` and `type` (no runtime importer at all), `packages/glob` (not a
module).

**npm publishing shrinks to the modules nothing outside this repo needs at run time** —
`codec`, `http-dispatch`, `kv-store` and `type` (no controller at all), plus `sql`, which stays
published *only* because `sql-sqlite` is still `pkg:npm`-delivered and depends on it; it goes
private the day that module is bundled. `ai`, `cache`, `embedding` and `vector-store` are module
code and stop publishing. The two sets are near-disjoint from the de-inlining set, and `kv-store` is in both, which
is coherent: publication answers "can a third party compile against this", the library layer answers
"which scope does it run in". Consequence, accepted: a third-party TypeScript module implementing
`Sql.Connection`, `Ai.Model`, `Cache.Store`, `Embedding.Model` or `VectorStore.Store` loses its
compile-time surface; its runtime contract (the manifest kind, plus the library layer resolved by
specifier) is unaffected.

**Release propagation is unchanged.** Once siblings are external their sources leave the dependents'
metafiles, so the inline edges vanish — but a dependent still bumps through the **import** edge,
which bumps unconditionally because publishing rewrites the sibling's pin into its manifest. Nothing
moves off the payload digest, and the release model's spine is untouched.

## Decisions

- **Only workspace modules are de-inlined.** Third-party dependencies (`kysely`, `pg`,
  `better-sqlite3`) and workspace packages that are not modules (`packages/glob`) have no module
  artifact to resolve against; inventing one for `kysely` would be building a package manager.
- **The mapping is declared in the manifest, not derived from the build.** It has to be checkable
  by a browser-safe analyzer with no build to inspect, and a manifest whose meaning depends on a
  build artifact is not statically analyzable.
- **The library layer reuses the controller locator vocabulary** rather than adding a second one, so
  selector matching, lazy materialization and platform fallthrough are inherited whole.
- **Bare-specifier resolution stays inside the kernel.** The published layer ships files only — no
  `package.json` in the artifact and no spec surface for one. `ensureRealmSymlinks` grows a sibling
  branch that materializes the sibling's library layer and writes a synthesized
  `node_modules/<specifier>/` beside the consumer's bundle, re-exporting the materialized entry;
  every consumer's shim re-exports the same underlying file, so identity and scope stay single.
- **A module artifact stops being self-contained, and that cost is accepted.** Controller loading
  gains an ordering dependency on the import graph being materialized first, which bundling had
  removed. The correctness bug outranks it, and materialization is already lazy and cached.
- **The property is JS-only for now.** A Rust controller cannot import a JS module's layer, so a
  Rust-side sibling library keeps inlining until the equivalent exists there. Stated rather than
  designed around, because the reverse — holding the fix until both runtimes can share it — leaves
  a known-broken shared-scope seam in place indefinitely.
- **`http-server` stays `pkg:npm`.** It resolves `@telorun/http-dispatch` from npm as today, and
  `http-dispatch` gets a library layer when that module moves to a bundle.
- **The `sql` `WeakMap`-on-an-injected-instance workaround stays**, and is removed as a follow-up.
  This change is about delivery; unwinding the seam it worked around is its own.
- **A fixture module owns its controller sources.** `ai`'s echo doubles used to live in
  `modules/ai/nodejs/src/` and be declared by a fixture module that imports `ai` — which is
  precisely the inlining this plan removes, so they moved to `modules/ai/tests/__fixtures__/`
  as a private workspace package. It is a package rather than loose files so the doubles keep
  type-checking against `@telorun/ai` and `@telorun/sdk` exactly as a third-party provider's
  controller does, which is the code path they exist to exercise.
