# Split `Kernel.Module` into `Kernel.Application` and `Kernel.Library`

## Goal

Replace the single `Kernel.Module` kind with two self-describing kinds:

- **`Kernel.Application`** — a runnable entry point. Required `targets`. Receives `env: process.env`. Loaded via `Kernel.loadFromConfig` (directly or by a parent kernel instance, e.g. the test suite). Never the target of a `Kernel.Import`.
- **`Kernel.Library`** — an importable unit of kinds/definitions. Required `exports` (or at least allowed to have them). No `targets`. No `env` access. Loaded only as the target of a `Kernel.Import`.

The distinction that currently lives implicitly in the *load path* (root vs imported) becomes explicit in the *manifest kind*.

## Non-goals

- Introducing a third kind for tests, or a `testOnly` flag. Tests work under the clean split: a test manifest is an Application (has `targets`, imports Libraries for their kinds), run by the test suite via a fresh kernel instance.
- Declarative app-to-app execution. There is no `Kernel.Spawn`. App-to-app runs stay runtime-level.
- Long-lived backwards compatibility for existing manifests. Every `telo.yaml` in the repo is rewritten as part of this change (no runtime shim, no fallback). However, **the editor plan's transitional parser** (legacy `Kernel.Module` → Application iff `targets:` present) must live for the duration of Phase 2 hand-review: while the hand-review is in flight the workspace contains a mix of legacy and migrated files, and the editor cannot break on the legacy kind. The kernel runtime itself rejects legacy `Kernel.Module` immediately — the bridge is editor-only.

---

## Schema changes

### `analyzer/nodejs/src/builtins.ts`

Replace the single `Kernel.Module` `Kernel.Definition` (currently [builtins.ts:63-114](analyzer/nodejs/src/builtins.ts#L63-L114)) with two:

- **`Kernel.Application`**
  - Fields: `metadata`, `lifecycle`, `keepAlive`, `targets`, `include`.
  - `targets` — **optional**. Applications whose work is carried entirely by auto-start Services (e.g. an HTTP server that begins serving in its `init()`) may declare no targets. Matches the prior `Kernel.Module` contract and avoids forcing authors to add a no-op target just to satisfy the schema.
  - `variables` / `secrets` — **forbidden**. An Application is a root with no parent to supply inputs — `loadFromConfig` takes no inputs, CLI doesn't plumb them, nothing populates them. Prior `Kernel.Module` schema allowed these fields but the runtime stored the schema dict itself as the "value" (e.g. `${{ variables.apiKey }}` would resolve to `{type: "string"}`); the split cleans that up by rejecting the fields outright. Runtime config for Applications comes from `env`. If a file needs an input contract, it's a Library.
  - `exports` — **forbidden**. Mixing entrypoint + library concerns in one file has no runtime meaning; if you want to export, the file is a Library.
- **`Kernel.Library`**
  - Fields: `metadata`, `variables`, `secrets`, `include`, `exports`.
  - `targets` — **forbidden**.
  - `lifecycle` / `keepAlive` — **forbidden**. Libraries are not lifecycle participants; these fields are meaningless on them. Schema rejection gives a clear error instead of silently ignoring.

Both kinds keep `include` (partial files remain a module-scoped concern, not a kind-specific one).

### `kernel/nodejs/src/manifest-schemas.ts`

Does not currently define `Kernel.Module` shape (grep confirms no direct reference). No change here beyond reusing whatever kind-agnostic validation already runs.

---

## Runtime behavior

### `kernel/nodejs/src/kernel.ts`

- [lines 130-133](kernel/nodejs/src/kernel.ts#L130-L133): controller registration. **Decision: register the same `module-controller.ts` under both new kinds.** The controller's behavior is largely kind-agnostic (include processing, scope registration); the parts that differ (targets, lifecycle) are already gated by inspecting the manifest's fields. Splitting into two controllers would duplicate ~all of the code. Registering twice is the smallest change.
- [line 172](kernel/nodejs/src/kernel.ts#L172): root-manifest identity registration. Accept either kind via `isModuleKind` helper.
- [line 207](kernel/nodejs/src/kernel.ts#L207): `setVariables` / `setSecrets` / `setTargets` on `rootContext`. Accept either kind via `isModuleKind`. `setTargets` on a Library's empty-targets field is a no-op.
- The boot path (`loadFromConfig`): a root manifest whose module doc is `Kernel.Library` is a hard error — libraries are not runnable entry points.
- `env: process.env` keeps flowing into the root `ModuleContext`. No change to the mechanism; only the gating condition becomes explicit (root doc must be `Kernel.Application`).

### `kernel/nodejs/src/controllers/module/import-controller.ts`

- A `Kernel.Import` whose target resolves to a `Kernel.Application` is a hard error. Import targets must be `Kernel.Library`.
- [line 54](kernel/nodejs/src/controllers/module/import-controller.ts#L54): the `manifests.find((m) => m.kind === "Kernel.Module")` that locates the target module's identity doc becomes `kind === "Kernel.Library"` specifically. The import path is the one site where `isModuleKind` would be wrong — we want to reject Application targets here, not accept them.
- **Remove the target-execution block at [import-controller.ts:107-109](kernel/nodejs/src/controllers/module/import-controller.ts#L107-L109).** This block lives inside the returned instance's `run:` method — it's a proxy-run path, not something that fires during import init. Under the new split, Libraries cannot have targets, so the path is dead code. Deleting it also enforces the explicit "no app-to-app declarative execution" rule.
- `ModuleContext` for an imported module continues to be constructed without `hostEnv` ([import-controller.ts:66-75](kernel/nodejs/src/controllers/module/import-controller.ts#L66-L75)). The no-env rule now matches the library kind 1:1 — documentation shifts from "imported modules don't see env" to "libraries don't see env".

### `kernel/nodejs/src/controllers/module/module-controller.ts`

- Handle both kinds. Most of the logic is kind-agnostic (include processing, module scope registration).
- The controller's kind→behavior branches reduce to: `Kernel.Application` may have targets registered for post-init execution; `Kernel.Library` may not.

### `kernel/nodejs/src/module-context.ts`

- No shape change. The `hostEnv` constructor arg continues to gate env visibility.
- No additional kind parameter. Presence/absence of `_hostEnv` already encodes "root Application" vs "imported Library"; diagnostics that need to distinguish can check it.

---

## Analyzer downstream

All required; same PR or immediate follow-up.

### `analyzer/nodejs/src/manifest-loader.ts`

- [line 15](analyzer/nodejs/src/manifest-loader.ts#L15): `SYSTEM_KINDS` adds both new kinds, drops `Kernel.Module`.
- [lines 109-114](analyzer/nodejs/src/manifest-loader.ts#L109-L114): "max one `Kernel.Module` per file" becomes "max one of `Kernel.Application` OR `Kernel.Library` per file". Enforce mutual exclusion (a file is either an Application or a Library, not both).
- [line 119](analyzer/nodejs/src/manifest-loader.ts#L119): `metadata.module` stamping uses either kind.
- [lines 253, 348](analyzer/nodejs/src/manifest-loader.ts#L253): update kind checks.

### `analyzer/nodejs/src/analyzer.ts`

- [lines 265-274](analyzer/nodejs/src/analyzer.ts#L265-L274): identity registration accepts either kind.

### `analyzer/nodejs/src/kernel-globals.ts`

- [line 18, 28, 35](analyzer/nodejs/src/kernel-globals.ts#L18): find the module manifest by checking for either kind. `variables`/`secrets` shape is the same on both; no schema branching needed.
- **Tiebreaker for cross-module `allManifests`.** [analyzer.ts:323](analyzer/nodejs/src/analyzer.ts#L323) passes the full cross-module manifest list into `buildKernelGlobalsSchema`. Post-split that list can contain both the root Application doc and multiple imported Library docs, and a bare `find(isModuleKind)` picks whichever appears first. Rule: **prefer the `Kernel.Application` if present**; otherwise fall back to the first `Kernel.Library`. The Application is the root whose `variables`/`secrets` contract is the one CEL expressions in the root module resolve against. (A deeper refactor to scope the call to a single module's manifests would be cleaner but is out of scope here.)

### `analyzer/nodejs/src/normalize-inline-resources.ts`

- [line 6](analyzer/nodejs/src/normalize-inline-resources.ts#L6): `SYSTEM_KINDS` update — replace `Kernel.Module` with both new kinds.

### Other `SYSTEM_KINDS` sets to audit

Multiple files maintain independent `SYSTEM_KINDS` sets with different membership. Each needs an explicit decision on whether Application and Library belong:

- [analyzer/nodejs/src/dependency-graph.ts:21](analyzer/nodejs/src/dependency-graph.ts#L21) — currently `{Kernel.Definition, Kernel.Import}`, excludes Module. Module docs currently flow through dependency-graph processing; audit whether Application/Library should behave the same or be excluded post-split.
- [analyzer/nodejs/src/validate-references.ts:9](analyzer/nodejs/src/validate-references.ts#L9) — currently `{Kernel.Definition, Kernel.Abstract}`, also excludes Module. Same audit question.

The audit outcome drives whether these sets gain the new kinds, stay as-is, or consolidate. Do not treat these as mechanical "replace the string" sites.

### `analyzer/nodejs/src/definition-registry.ts`

- [line 55](analyzer/nodejs/src/definition-registry.ts#L55) comment + logic: registration happens on Library load (definitions are a library concern). Applications may still contain `Kernel.Definition` docs, but this is rare in practice; keep the registration path kind-agnostic.

### New validation rules (analyzer-enforced)

- `Kernel.Library` with a `targets` field → error.
- `Kernel.Import` whose resolved target is a `Kernel.Application` → error (with a remediation hint: "Applications are run directly, not imported").
- A manifest file with a `Kernel.Application` doc and a `Kernel.Library` doc → error.
- A file used as a root (`loadFromConfig`) whose module doc is `Kernel.Library` → error at load time.

These rules make the invariant checkable statically, not just at runtime.

---

## Repository-wide manifest migration

Grep finds ~90 files referencing `Kernel.Module`. Classify each:

- **Library**: everything under `modules/*/telo.yaml` (console, sql, run, assert, http-server, http-client, config, type, javascript, starlark, s3, tracing, test, benchmark, workflow, workflow-temporal, sql-repository, dev). Core standard-library modules.
- **Application**: everything runnable — `apps/registry/telo.yaml`, `examples/*.yaml`, `tests/*.yaml`, `modules/*/tests/*.yaml`, `benchmarks/*.yaml`, `test-suite.yaml`.
- **Partial files** (no `Kernel.Module` header, loaded via `include:`): unchanged.

Migration is two-phase:

- **Phase 1 — auto-rewrite `modules/*/telo.yaml` → Library.** ~20 files, all unambiguously library-shape (kind definitions, no `targets`). A small script walks the list and rewrites the `kind:` line. Mechanical.
- **Phase 2 — hand-review everything else.** Tests, examples, benchmarks, apps. These have more variety, and the classification *is* the intent — don't auto-guess. If a Library-bound file secretly has `targets`, or an Application-bound file is imported somewhere, that's a real finding and should be fixed during review, not papered over by the migration script.

Migration rules:

1. (Both phases) `kind: Kernel.Module` → `kind: Kernel.Application` if the file declares `targets:` or is loaded as a root (tests, examples, registry app).
2. (Both phases) `kind: Kernel.Module` → `kind: Kernel.Library` otherwise.
3. (Phase 2 hand-review only) If an author manually classifies a file as Library but it still has `targets`, rule 1 would have auto-promoted it — the conflict means intent is unclear. Resolve by either promoting to Application or removing the targets, not by silently accepting invalid schema.

### Editor references

- [apps/telo-editor/src/loader.ts:184, 429](apps/telo-editor/src/loader.ts#L184): update to look for either kind. Covered by the editor plan's `ParsedManifest` change.

### VS Code extension

- [ide/vscode/src/completion.ts](ide/vscode/src/completion.ts): update any `Kernel.Module` completion entries to offer both new kinds.

### Docs

- [CLAUDE.md](CLAUDE.md): rewrite the `Resource Kinds` section.
- [kernel/docs/modules.md](kernel/docs/modules.md), [kernel/docs/evaluation-context.md](kernel/docs/evaluation-context.md), [kernel/docs/resource-references.md](kernel/docs/resource-references.md): update.
- [guides/style-guide.md](guides/style-guide.md), [guides/templating.md](guides/templating.md): update examples.
- Per-module docs under `modules/*/docs/` and `pages/`: update any example snippets.

---

## Test plan

- Every existing test in `tests/` and `modules/*/tests/` must continue to pass after classification.
- Add new analyzer tests covering the four static rules above (Library-with-targets, Import-targets-Application, both-kinds-in-one-file, root-is-Library).
- Add a kernel runtime test that attempts to `loadFromConfig` a `Kernel.Library` manifest and asserts a clear error.
- Update `tests/include-rejects-system-kinds.yaml` and its fixtures to cover both new kinds (existing test only exercises `Kernel.Module`). [manifest-loader.ts:198](analyzer/nodejs/src/manifest-loader.ts#L198) rejects system kinds in `include:` partials; the rule must stay intact and be tested against `Kernel.Application` and `Kernel.Library` as well.

---

## Removal list

Concrete deletions in this change:

- `import-controller.ts:107-109` target-execution block (returned `run:` proxy).
- Any logic that treats "imported modules with targets" as valid, anywhere in kernel or analyzer.
- `"Kernel.Module"` string literals — replaced everywhere with either a helper (`isModuleKind(k) => k === "Kernel.Application" || k === "Kernel.Library"`) or with the specific kind the site actually cares about.

Full audit of string-literal sites, each with the semantics the replacement must preserve:

| Site | Current | Replace with |
|------|---------|--------------|
| [kernel.ts:130-133](kernel/nodejs/src/kernel.ts#L130-L133) | `registerController("Kernel.Module", ...)` | register under **both** new kinds |
| [kernel.ts:172](kernel/nodejs/src/kernel.ts#L172) | `m.kind === "Kernel.Module"` (identity) | `isModuleKind(m.kind)` |
| [kernel.ts:207](kernel/nodejs/src/kernel.ts#L207) | `manifest.kind === "Kernel.Module"` | `isModuleKind(manifest.kind)` |
| [import-controller.ts:54](kernel/nodejs/src/controllers/module/import-controller.ts#L54) | `m.kind === "Kernel.Module"` (import target) | `m.kind === "Kernel.Library"` (strict) |
| [manifest-loader.ts:15, 109, 112, 119, 253, 348](analyzer/nodejs/src/manifest-loader.ts#L15) | various `"Kernel.Module"` checks | `isModuleKind` / update error messages |
| [analyzer.ts:270](analyzer/nodejs/src/analyzer.ts#L270) | identity registration | `isModuleKind` |
| [kernel-globals.ts:18, 35](analyzer/nodejs/src/kernel-globals.ts#L18) | `SYSTEM_KINDS` + `find` | set contains both; `find` prefers Application |
| [normalize-inline-resources.ts:6](analyzer/nodejs/src/normalize-inline-resources.ts#L6) | `SYSTEM_KINDS` | set contains both |
| [dependency-graph.ts:21](analyzer/nodejs/src/dependency-graph.ts#L21) | `SYSTEM_KINDS` without Module | audit — decide Application/Library membership |
| [validate-references.ts:9](analyzer/nodejs/src/validate-references.ts#L9) | `SYSTEM_KINDS` without Module | audit — decide Application/Library membership |
| [apps/telo-editor/src/loader.ts:779](apps/telo-editor/src/loader.ts#L779) | hardcoded `kind: "Kernel.Module"` on serialize | read `ParsedManifest.kind`; output either |

Introduce one small helper to avoid duplicating the either-or check:

```ts
// kernel/nodejs/src/module-kinds.ts (new) — or re-export from index
export const MODULE_KINDS = ["Kernel.Application", "Kernel.Library"] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];
export function isModuleKind(kind: string): kind is ModuleKind {
  return kind === "Kernel.Application" || kind === "Kernel.Library";
}
```

Use this everywhere a current site checks `kind === "Kernel.Module"` for "is this the module-identity doc in this file" purposes. Do **not** use it where the site actually needs to distinguish app from library (env gating, target execution, import target validation — `import-controller.ts:54` is the canonical example).

---

## Open items

- **Registry publish rejection timing.** The registry plan is a separate change. Between this split shipping and the registry enforcement landing, nothing prevents publishing a `Kernel.Application` to the registry. Two options: (a) block this change from shipping until registry enforcement is ready — safest, but couples unrelated timelines; (b) ship the split now with a known window during which invalid publishes are possible, and add a one-liner in the publish path that rejects non-Library manifests as an interim guard. **Recommendation: (b) with the interim guard** — it keeps the split independently shippable and closes the window with minimal work. Call out in the change log.

Items decided during design (recorded for reference):

- `exports` on Applications is **forbidden** (see schema section). Clean partition; if you want to export, the file is a Library.
- `lifecycle` and `keepAlive` on Libraries are **forbidden** by schema (see schema section). Rejecting teaches the model; silently ignoring would breed confused YAML.
- Migration is two-phase: auto-rewrite `modules/*/telo.yaml`, hand-review everything else (see migration section).
- Module controller is registered under both new kinds (see kernel.ts section). No split into two controllers.
- `ModuleContext` gains no extra kind parameter; `_hostEnv` already encodes the distinction.
- `kernel-globals.buildKernelGlobalsSchema` prefers the Application doc when the passed manifest list contains both kinds (see kernel-globals section).
