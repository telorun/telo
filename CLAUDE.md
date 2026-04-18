# Claude

Use `pnpm run telo ./manifest.yaml` for testing.
Use `pnpm run test` to run the full test suite (runs `test-suite.yaml` which discovers all `tests/*.yaml` across the repo).
Tests should live in the module they test: `modules/<name>/tests/*.yaml`.
Test fixtures go in `__fixtures__/` subdirectories (excluded from test discovery).

Follow this strictly:

- never build anything
- never add underscores to unused function arguments
- never look at commit history
- never stash changes to investigate anything
- never fix linting problems
- never implement logic that swallows errors
- telo manifests MUST be type safe
- never use `cat` nor `sed` to read files — read them directly
- never modify files in `dist` directories
- never use Bun-only APIs (e.g. `Bun.Glob`, `Bun.file`); all code must run on Node.js
- never make architectural decisions (package boundaries, dependency direction, where code lives) without asking first
- UI primitives must use Radix (`radix-ui` package, same pattern as `apps/telo-editor/src/components/ui/*`); if a needed component isn't wrapped yet, install it via shadcn before rolling your own

## Architecture

Telo is a declarative runtime: YAML manifests describe desired state, the kernel resolves resource dependencies via a multi-pass init loop, and controllers implement each resource kind. CEL expressions in `${{ }}` are compiled before execution.

**Topology-driven constraint:** The analyzer and telo editor must never hardcode knowledge about specific resource kinds. All resource-specific behaviour must be expressed via `x-telo-*` schema annotations in `Telo.Definition` schemas and resolved generically.

**Browser compatibility:** The `analyzer` package must be runnable in the browser without Node.js polyfills. Do not import Node.js built-ins (`fs`, `path`, `url`, `child_process`, etc.) from analyzer code. Node.js-specific adapters belong in the consuming package (kernel, IDE extension, CLI).

## Monorepo Structure

- `kernel/nodejs/src/` — core runtime: orchestration, loading, controllers, init loop
- `cli/nodejs/` — CLI wrapper (`bin/telo.mjs`)
- `sdk/nodejs/src/` — public API for module authors (re-exports kernel contexts + capability interfaces)
- `modules/` — standard library: `http-server`, `http-client`, `sql`, `javascript`, `config`, `run`, `assert`, `test`, `console`, etc.
- `yaml-cel-templating/nodejs/` — CEL + YAML directive engine (`$let`, `$if`, `$for`, `$eval`, `$include`)
- `analyzer/nodejs/` — static manifest validator (schema checks, reference validation, CEL type-checking)
- `apps/telo-editor/` — desktop editor (React + Vite + Tauri)
- `ide/vscode/` — VS Code extension (YAML diagnostics via analyzer)
- `tests/` — integration tests (YAML manifests run via kernel)
- `examples/` — sample manifests

## Kernel Internals (`kernel/nodejs/src/`)

- `kernel.ts` — main orchestrator, boot sequence, multi-pass init loop, event bus
- `loader.ts` — YAML loading + CEL-YAML compilation; accepts `compileContext` param
- `evaluation-context.ts` — `EvaluationContext`, `ModuleContext` — variable/secret/resource scoping
- `resource-context.ts` — bridge: `getModuleContext()`, `registerModuleImport()`
- `module-context-registry.ts` — per-module store for variables, secrets, resources, imports
- `controller-registry.ts` — maps resource kinds to controller implementations
- `controllers/module/module-controller.ts` — handles `kind: Telo.Application` / `kind: Telo.Library` (includes, module scope)
- `controllers/module/import-controller.ts` — handles `kind: Telo.Import` (external modules, export CEL eval)
- `controllers/resource-definition/` — handles `kind: Telo.Definition` and parameterized templates
- `capabilities/` — base interfaces: runnable, invokable, listener, provider, template, mount
- `manifest-schemas.ts` — JSON Schema for YAML validation

## Resource Kinds

Every module file must start with exactly one `Telo.Application` OR `Telo.Library` doc. Applications are runnable entry points, Libraries are importable units of kinds/definitions. The two kinds share most fields; what differs is runtime role.

### `kind: Telo.Application`

A runnable entry point. Loaded via `Kernel.loadFromConfig` (directly, or by the test suite spawning a fresh kernel). **Never** the target of a `Telo.Import` — importing an Application is rejected at load time.

- `metadata.name` — kebab-case; becomes the kind prefix (e.g. `MyModule.*`)
- `metadata.namespace` — optional grouping prefix for `x-telo-ref` resolution
- `lifecycle` — `"shared"` (default) | `"isolated"`
- `keepAlive` — prevent kernel exit when idle
- `include` — array of file paths/globs to load as partial files into the same module scope; partial files must not contain `Telo.Application`, `Telo.Library`, `Telo.Import`, or `Telo.Definition`
- `targets` — optional; run after all resources init; must reference `Telo.Runnable` or `Telo.Service`. A no-targets Application is valid when its work is carried by Services that auto-start on init.
- Receives `env: process.env` when it is the root loaded manifest.
- `variables` / `secrets` / `exports` are **forbidden** — an Application is a root with no parent to supply inputs. Use `env` for runtime config. If you want to export or accept variables/secrets, the file is a Library.

### `kind: Telo.Library`

An importable unit of kinds/definitions. Loaded **only** as the target of a `Telo.Import`. Cannot be run directly; `loadFromConfig` on a Library manifest is a hard error.

- `metadata.name` / `metadata.namespace` — as Application.
- `variables` / `secrets` — JSON Schema property map; public contract for importers.
- `include` — same semantics as Application.
- `exports.kinds` — which kinds importers may reference.
- `targets` is **forbidden**. `lifecycle` / `keepAlive` are also forbidden — libraries are not lifecycle participants.
- No `env` access.

### `kind: Telo.Import`

Loads a `Telo.Library` into the current scope under a PascalCase alias.

- `source` — relative path / registry ref / URL; resolved to `telo.yaml` automatically.
- `variables` / `secrets` — values passed into the child library.
- Creates an isolated child `EvaluationContext`; child resources not visible to root scope.
- Importing a `Telo.Application` is a hard error — applications are run directly, not imported.
- Only root module gets `env: process.env`; child modules are isolated from the host environment.

### `kind: Telo.Definition`

Registers a new resource kind. Defined inline in a module's `telo.yaml`.

- `metadata.name` — kind suffix; full kind = `<module-name>.<Name>`
- `capability` — one of the kernel capabilities (see below)
- `controllers` — `pkg:npm` locator; `local_path` is a relative fallback for local development
- `schema` — JSON Schema with `x-telo-*` annotations

## Capabilities

- `Telo.Service` — `init()` + optional `teardown()`; long-lived servers, pools
- `Telo.Runnable` — `run()`; one-shot tasks, pipelines
- `Telo.Invocable` — `invoke(inputs)`; request handlers, scripts
- `Telo.Provider` — `init()`; config/secret providers; all fields implicitly `x-telo-eval: compile`
- `Telo.Mount` — mounted into a Service (e.g. HTTP APIs, middleware)
- `Telo.Type` — pure schema definition, no runtime instance

Defined as `Telo.Abstract` entries in `builtins.ts`.

## x-telo-\* Schema Annotations

Inside `Telo.Definition` schema blocks:

- `x-telo-eval: "compile" | "runtime"` — when `${{ }}` expressions are evaluated: at load time (compile) or per invocation (runtime). Without annotation, strings pass through raw.
- `x-telo-ref: "namespace/module-name#TypeName"` — field must be a named reference to a resource of that capability/type. Validated at Phase 3; replaced with live `ResourceInstance` at Phase 5.
- `x-telo-scope: "/json/pointer"` — marks an execution scope; resources inside are initialized on-demand, not at boot. Controller receives a `ScopeHandle`.
- `x-telo-schema-from: "refProp/$defs/Name"` — derives field validation schema from a sibling `x-telo-ref` resource's definition schema. Used for polymorphic config.
- `x-telo-context: <JSON Schema>` — annotates a handler field with the CEL context available inside it. Analyzer-only; no runtime effect.
- `x-telo-step-context: { invoke, outputType }` — on an array field, tells the analyzer to build typed `steps.<name>.result` context from each item's invoked resource's output type.

## CEL Templates (`${{ }}`)

Pure expression: `"${{ variables.port }}"` → typed value. Inline: `"Hello ${{ variables.name }}!"` → string.

Available in `${{ }}`:

- `variables`, `secrets` — always available (module inputs)
- `resources.<name>` — after that resource's `snapshot()`
- `steps.<step>.result` — inside `Run.Sequence` steps
- `request` — inside handler CEL (HTTP: query, body, params, headers, path, method)
- `env` — only in root module (compile context)

YAML directives: `$let`, `$if`, `$for`, `$eval`, `$include` — see `yaml-cel-templating/nodejs/`.

## Where to Look

- Runtime bug / init order → `kernel.ts`, `loader.ts`
- Module/import scoping → `evaluation-context.ts`, `module-context-registry.ts`, `import-controller.ts`
- New resource kind → add `Telo.Definition` to module's `telo.yaml`, controller in `src/`
- CEL template syntax → `yaml-cel-templating/nodejs/`
- Schema validation errors → `manifest-schemas.ts`, `analyzer/nodejs/`
- x-telo-ref / scope / topology → `analyzer/nodejs/src/reference-field-map.ts`, `dependency-graph.ts`, `validate-references.ts`
- CEL type checking → `analyzer/nodejs/src/validate-cel-context.ts`, `cel-environment.ts`
- Test a manifest → add to `tests/`, run `pnpm run test`
- Controller CLI args → `kernel.ts` (`parseArgsForController`), `resource-context.ts`
- Test runner → `modules/test/nodejs/src/suite.ts`

## Module Documentation — MANDATORY

**Every module change MUST include documentation updates.** This is not optional. Before finishing any task that adds or modifies a module, verify:

1. Documentation exists in `modules/<name>/docs/`. If not, create it.
2. Documentation matches the current code. If code changed, docs must be updated.
3. New documentation files are wired into GitHub Pages (Docusaurus):
   - Add the file path to `pages/docusaurus.config.ts` in the `include` array
   - Add a sidebar entry in `pages/sidebars.ts`
   - Add `sidebar_label` frontmatter to the markdown file

## Keep CLAUDE.md up to date

Sync this file after any significant architectural change.
