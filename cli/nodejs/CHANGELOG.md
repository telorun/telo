# @telorun/cli

## 0.4.0

### Minor Changes

- 6a61dbf: Add `telo install <path>` — pre-downloads every controller declared by a manifest and its transitive `Telo.Import`s into the on-disk cache. At runtime the kernel finds each controller already cached and skips the boot-time `npm install`, removing the startup delay and the network dependency from production containers.

  Reuses the existing `ControllerLoader`, so resolution semantics (local_path, node_modules, npm fallback, entry resolution) are identical to runtime loading. Jobs run in parallel via `Promise.allSettled`; failures are reported per controller and the command exits non-zero if any failed.

  `ControllerLoader` is now exported from `@telorun/kernel`.

  **Cache location**: defaults to `~/.cache/telo/` (XDG-style, shared across projects for a user). Override via `TELO_CACHE_DIR` — set it per-project to bundle the cache alongside the manifest. The registry image now uses `TELO_CACHE_DIR=/srv/.telo-cache` so `telo install` at build time and `telo run` at boot both read/write the same project-local cache, and a single `COPY --from=build /srv /srv` carries the full bundle into the production stage.

### Patch Changes

- Updated dependencies [6a61dbf]
  - @telorun/kernel@0.4.0

## 0.3.3

### Patch Changes

- Updated dependencies [f75a730]
- Updated dependencies [f75a730]
  - @telorun/kernel@0.3.3

## 0.3.2

### Patch Changes

- 3c4ac58: Resource initialization errors now carry the resource `kind`, an underlying error `code`, and a structured `details` block extracted from the original error — AWS SDK service exceptions expose HTTP status / request ID / fault, pg database errors expose severity / detail / hint / SQLSTATE / routine, Node system errors expose syscall / address / port, and the full `cause` chain is walked. The CLI renders runtime diagnostics distinctly from static-analysis diagnostics: no redundant file path, `kind` and `name` shown as the heading, details indented below.
- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2
  - @telorun/kernel@0.3.2
  - @telorun/analyzer@0.2.1

## 0.3.1

### Patch Changes

- 2d866be: Add `--skip-controllers` flag to `telo publish`. When set, skips the controller build/publish/PURL-rewrite loop and only runs static analysis and pushes the manifest to the Telo registry. Used by the Changesets-driven CI release flow, where controller packages are already published by `changeset publish`.

## 0.3.0

### Minor Changes

- 31d721e: feat: bearer-token auth for the Telo module registry publish endpoint

  The registry's `PUT /{namespace}/{name}/{version}` now requires an `Authorization: Bearer <token>` header. Reads stay anonymous. Tokens are provisioned declaratively at boot via `TELO_PUBLISH_TOKEN` and stored as SHA-256 hashes in a `tokens` table joined to `users` and `namespaces`.

  **Analyzer** (`@telorun/analyzer`) — **breaking for direct API consumers**

  - `StaticAnalyzer` and `Loader` now accept an optional `{ celHandlers }` in their constructors. Analyzer-only callers (VS Code extension, Docusaurus preview, CLI `check`/`publish`) can omit it and get throwing stubs. Runtime callers (kernel) must supply real handlers.
  - The module-level `celEnvironment` singleton is removed — `precompile.ts` now takes the `Environment` as a parameter.
  - New CEL stdlib function: `sha256(string): string`. Always registered with the correct signature so `env.check()` type-checks; behaviour depends on the supplied handler.
  - The throws-union resolver recognises the new `throw:` step shape (see Run module) and resolves its code at the call site using the same rules as passthrough invocables (literal / `${{ 'LIT' }}` / `${{ error.code }}` in catch).
  - CEL type-check failures now surface as diagnostics. Previously the analyzer only reported schema/type mismatches on valid expressions; `env.check(...)` returning `{ valid: false }` (wrong method, wrong operand types, wrong overload — e.g. `s.slice(7)` on a dyn) was silently dropped. Now surfaces as `SCHEMA_VIOLATION` with a `CEL type error:` message.

  **Kernel** (`@telorun/kernel`)

  - Constructs `StaticAnalyzer` and `Loader` with a `node:crypto`-backed `sha256` handler, so CEL templates invoking `sha256()` evaluate at runtime.

  **Run module** (`@telorun/run`) — **breaking**

  - `Run.Sequence` gains a first-class `throw:` step variant: `- name: X; throw: { code, message?, data? }` — throws `InvokeError` directly from inside the sequence. Works inside `catch:` blocks via `code: "${{ error.code }}"` for re-raise. A malformed `throw.code` (non-string or empty after expansion) is itself reported as `InvokeError("INVALID_THROW_STEP", …)` rather than a plain Error, so the failure stays in the structured-error channel and a surrounding `catches:` can map it.
  - The `Run.Throw` invocable is removed. Existing `invoke: { kind: Run.Throw }` call sites must migrate to `throw:` steps. The separate kind was redundant with the new step form, and the `throw:` step expresses the intent more directly inside sequences.
  - **Event-stream change:** `throw:` steps do **not** emit a scoped `<Kind>.<name>.InvokeRejected` event the way `Run.Throw` did. The error is thrown from inside the sequence's own `invoke()`, so the enclosing kind's event is what fires (e.g. `Run.Sequence.<handlerName>.InvokeRejected` — or nothing, when an enclosing `try` absorbs the throw). Downstream observers that filtered on `Run.Throw.*.InvokeRejected` must switch filters.

  **CLI** (`@telorun/cli`)

  - `telo publish` reads `TELO_REGISTRY_TOKEN` and sends it as `Authorization: Bearer <token>`. Without the env var, publishes to auth-gated registries fail with 401.

  See `apps/registry/plans/registry-auth.md` for the full plan.

### Patch Changes

- Updated dependencies [353d7e5]
- Updated dependencies [31d721e]
  - @telorun/sdk@0.3.0
  - @telorun/kernel@0.3.0
  - @telorun/analyzer@0.2.0

## 0.2.9

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.4
  - @telorun/kernel@0.2.9

## 0.2.8

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.3
  - @telorun/kernel@0.2.8

## 0.2.7

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.2
  - @telorun/kernel@0.2.7

## 0.2.6

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.1
  - @telorun/kernel@0.2.6

## 0.2.5

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/kernel@0.2.5

## 0.2.4

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/kernel@0.2.4

## 0.2.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/runtime@0.2.3

## 0.2.2

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/runtime@0.2.2
