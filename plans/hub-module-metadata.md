# Hub module metadata & badges

Follow-up to [federated-discovery.md](federated-discovery.md), which built the index. This plan makes a hit *legible*: what can run it, who published it, whether it is still current.

## Problem

Ingest reads a manifest for name, capability, description, categories and `extends`, and discards the rest. Four consequences:

- **`controllers:` is never read at all**, so the hub cannot say which kernel can load a kind. In a polyglot runtime that is not cosmetic: `search_resources` will happily hand an agent composing for the Rust kernel a kind whose only controller is JavaScript, and nothing in the response says so. The signal is per *kind*, not per module — `std/console` ships Rust controllers for two of its four kinds, so any module-level claim would be false.
- **`repository` and `license` are ingested and rendered nowhere.** `metadata.homepage` does not exist as a field.
- **Deprecation is prose.** `Sql.Migration` announces its own replacement inside its description, where nothing can badge it, link it, or warn on install.
- **No module has a URL.** Detail is a drawer over the search page, so nothing is linkable or shareable.

## Solution

**Derivation happens in the CLI, not the hub.** `telo module manifest --json` gains derived per-kind metadata alongside the manifest it already returns: which kernels can load each kind, and which language its controllers are written in, classified from the `controllers:` PURL candidates. The mapping from PURL to kernel is loader knowledge (`kernel/nodejs/src/controller-loaders/`, `kernel/rust/src/controller_loaders/`), and the CLI already links both halves; the hub stores what the verb reports and parses no PURLs itself. The verb stays generic — "what would run this, and where" is useful to any script, not just the tracker.

A kind that declares **no** controllers is marked **portable** — no runtime constraint — rather than having today's kernels enumerated into it. Language is recorded only where the PURL actually determines it.

**Two new manifest fields.** `metadata.homepage` and `metadata.deprecated` on library docs, and `metadata.deprecated` on kind docs. Deprecation carries a reason and an optional replacement, whose form follows the level: a library doc names a **module ref** (the `imports:` source grammar), a kind doc names an **alias-qualified kind** (`Self.<Kind>` or `<Alias>.<Kind>`) — the same grammar `kind:`, `extends:` and `x-telo-ref` already use, so ingest resolves it through the declaring manifest's own `imports:` map with the resolver it already runs for `extends`, and the replacement arrives as a linkable target.

Today **no schema exists for `Telo.Application` / `Telo.Library` metadata at all** — `manifest-schemas.ts` wires `metadataSchema` only into `Telo.Definition` and `Telo.Abstract`. A minimal library/application metadata schema therefore lands in the analyzer, covering the fields already established by convention (`version`, `description`, `repository`, `license`, `documentation`, `categories`) plus the two new ones, and staying open to anything else. Without it a misspelled `deprecated:` would silently do nothing.

**Ingest, storage and API.** Per-kind rows gain runtimes, languages, the portable flag and resolved deprecation; per-version rows gain homepage, deprecation, and a per-runtime rollup of **full / partial / none** over the module's kinds. Publisher is derived from the ref's host and organisation rather than declared — ownership is a property of the host, and a self-asserted field on an open, unauthenticated registry verifies nothing. Existing tracked rows backfill themselves through the tri-state precedent set by `module_versions.integrity`: a null rollup means *never asked* and triggers re-ingest on the next tracking pass, so no separate backfill job exists.

`/search/resources`, `/search/modules` and the MCP `search_resources` tool gain a runtime filter — the correctness case above is the reason it belongs on the MCP surface and not only in the UI. A new module detail endpoint serves the page in one call; today there is none.

**Frontend.** Module detail moves out of the drawer onto a real path route, with the GitHub Pages `404.html` fallback that a static SPA needs. The page carries runtime, language and portable badges, a deprecation banner linking the resolved replacement, and the license, repository and homepage links that are already indexed but unrendered. Prerendering and SEO stay out of scope: the page becomes linkable here, indexable later.

**Stdlib adoption is minimal.** A manifest edit changes a module's published bytes and so demands a changie fragment and a republish. The plumbing therefore lands without touching the 56 modules that have nothing to declare. Two adopt `deprecated`, where the fact is already true and merely unstructured: `sql`, on its `Migration` kind, and `type`, whose deprecation in favour of the kernel built-in `Telo.JsonSchema` currently lives in a YAML comment at the top of the file — invisible to the hub, and the exact failure this plan exists to fix. `type` takes it at both levels: on the library doc with a reason only, since a kernel built-in has no module ref to point at, and on its `JsonSchema` kind as `Telo.JsonSchema`, which resolves through the built-in path ingest already handles. No module adopts `homepage`; the field earns its place on third-party modules, where homepage and repository genuinely differ, whereas all 58 stdlib modules share one monorepo `repository`.

## Decisions

- **Classification lives in the CLI verb, not hub CEL.** The hub is declarative and could parse PURLs in CEL as it already does for `extends` aliases, but that copies loader knowledge into a second place and drifts silently when a loader lands. Rejected: an analyzer helper shared with the editor (correct eventually, but no second consumer exists yet and it widens the change for no present gain).
- **Runtime and language are two axes, not one.** `pkg:npm` and `pkg:telo/local/js` are both JavaScript *and* Node-kernel; `pkg:telo/local/napi` is native code loaded *by* the Node kernel and could be Rust or C++. Collapsing them would make one of the two claims wrong.
- **No language is recorded for `napi` / `wasm`.** The PURL does not determine it, and a blank is worth more than a guess.
- **A controller-less kind is `portable`, not "runs on Node and Rust".** Enumerating current kernels makes every stored row wrong the day a third kernel ships; a "no constraint" marker stays true.
- **Runtime support rolls up as full / partial / none.** `std/console` is the proof that a boolean lies.
- **Publisher is derived from the ref, `authors` is not added.** Ownership derives from the host, per the federation plan; a declared author field on an open registry is unverifiable decoration. Rejected: a declared `authors`/`maintainers` field.
- **`replacedBy` is resolvable, and its form follows the level.** A free string cannot be linked or validated. Accepted limit: a kind whose replacement lives in a module it does not import cannot be named — such a case uses module-level deprecation instead. Rejected: a second grammar pairing a raw ref with a kind suffix; declaring a real import purely to name a deprecation target.
- **A library/application metadata schema is introduced.** Slightly wider than the two fields require, but shipping a field nothing validates contradicts the rule that errors are surfaced, not swallowed.
- **Backfill reuses the `integrity` tri-state.** Proven in this codebase, and it needs no migration job.
- **Minimum kernel version and platform badges are out of scope.** A version floor is decorative unless the kernel enforces it at load, which is a runtime-semantics change; no module declares `os`/`arch`/`libc` today and published artifacts carry no `layers:` block, so a platform badge would render nothing. Both are separate plans.
- **SEO and prerendering are deferred.** Routing is the prerequisite and ships here; indexing is its own pass.

## Complete example after the change

A module declares the new fields, and deprecates a kind in favour of its sibling:

```yaml
kind: Telo.Library
metadata:
  name: sql
  version: 0.9.0
  homepage: https://telo.run/modules/sql
  repository: https://github.com/telorun/telo
  license: LicenseRef-SustainableUse
---
kind: Telo.Definition
metadata:
  name: Migration
  description: A single standalone schema-migration script.
  deprecated:
    reason: Declare migrations inline in the keyed migrations map instead.
    replacedBy: Self.Migrations
capability: Telo.Provider
```

The hub then reports `sql.Migration` as deprecated with a link to `sql.Migrations`, and — because every kind in the module carries only `pkg:telo/local/js` controllers — badges the module as JavaScript, Node-kernel only. `std/console` badges as Node (full) and Rust (partial); `std/kv-store`, which declares no controllers anywhere, badges as portable. A caller running the Rust kernel filters `search_resources` to it and never sees a kind that kernel cannot load.
