# Claude

Use `pnpm run telo ./manifest.yaml` for testing.
Use `pnpm run test` to run the full test suite (runs all `tests/*.yaml` via bun).

Follow this strictly:

- never build anything.
- never add underscores to unused function arguments.
- never look at commit history.
- never stash changes to investigate anything.
- never fix linting problems.
- never implement logic that swallows errors
- kernel MUST be type safe
- never use `cat` nor `sed` to read files - read them directly.

## Architecture

Telo is a declarative runtime: YAML manifests describe desired state, the kernel resolves resource dependencies via a multi-pass init loop, and controllers implement each resource kind. CEL expressions in `${{ }}` are compiled before execution.

## Monorepo Structure

| Path | Purpose |
|------|---------|
| `kernel/nodejs/src/` | Core runtime — orchestration, loading, controllers, init loop |
| `cli/nodejs/` | CLI wrapper around kernel (`bin/telo.mjs`) |
| `sdk/nodejs/src/` | Public API for building modules (contexts, capabilities, types) |
| `modules/` | Standard library — HTTP, SQL, Flow, scripting, config, etc. |
| `yaml-cel-templating/nodejs/` | CEL + YAML directive engine (`$let`, `$if`, `$for`, `$eval`, `$include`) |
| `analyzer/nodejs/` | Static manifest validator (schema checks, alias resolution) |
| `apps/telo-editor/` | Desktop editor — Next.js + Tauri |
| `ide/vscode/` | VS Code extension — YAML diagnostics via analyzer |
| `tests/` | Integration tests (YAML manifests run via kernel) |
| `examples/` | Sample manifests |

## Kernel Internals (`kernel/nodejs/src/`)

| File | Role |
|------|------|
| `kernel.ts` | Main orchestrator — boot sequence, multi-pass init loop, event bus |
| `loader.ts` | YAML loading + CEL-YAML compilation; accepts `compileContext` param |
| `evaluation-context.ts` | `EvaluationContext`, `ModuleContext` — variable/secret/resource scoping |
| `resource-context.ts` | Bridge methods: `getModuleContext()`, `registerModuleImport()` |
| `module-context-registry.ts` | Per-module store for variables, secrets, resources, imports |
| `controller-registry.ts` | Maps resource kinds to controller implementations |
| `controllers/module/module-controller.ts` | Handles `kind: Kernel.Module` (includes, module scope) |
| `controllers/module/import-controller.ts` | Handles `kind: Kernel.Import` (external modules, export CEL eval) |
| `controllers/resource-definition/` | Handles `kind: Kernel.Definition` and parameterized templates |
| `capabilities/` | Base interfaces: `runnable`, `invokable`, `listener`, `provider`, `template`, `mount` |
| `event-stream.ts` | Event bus |
| `manifest-schemas.ts` | JSON Schema for YAML validation |

## Modules (`modules/<name>/`)

Each module owns specific resource kinds. Structure: `module.yaml` (module def), `*.definition.yaml` (type defs), `src/` (TS controllers).

Key modules: `http-server`, `http-client`, `sql`, `flow`, `javascript`, `config`, `pipeline`, `assert`, `console`.

## SDK vs Kernel

- **Kernel** (`kernel/nodejs/src/`) — internal runtime, not for external consumption
- **SDK** (`sdk/nodejs/src/`) — public surface for module authors; re-exports contexts and capability interfaces

## Where to Look

- **Runtime bug / init order issue** → `kernel.ts`, `loader.ts`
- **Module/import scoping** → `evaluation-context.ts`, `module-context-registry.ts`, `import-controller.ts`
- **New resource kind** → add definition in a module's `*.definition.yaml`, controller in `src/`
- **CEL template syntax** → `yaml-cel-templating/nodejs/`
- **Schema validation errors** → `manifest-schemas.ts`, `analyzer/nodejs/`
- **Test a manifest** → add to `tests/`, run `pnpm run test`
