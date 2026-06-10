# Config value-flow into library imports

## Problem

An import's `variables:`/`secrets:` values that contain CEL expressions — written either `${{ }}` or `!cel` — are baked into the child library context **verbatim** as unevaluated compiled-value objects, instead of being evaluated against the importing module's scope. Both syntaxes compile to the same wrapper, so both fail identically. So config cannot flow from an application through intermediate libraries into leaf libraries.

Reproduced: with `imports: { Data: { variables: { dbFile: "${{ variables.dbFile }}" } } }` (and the equivalent `!cel "variables.dbFile"`), the leaf's `Sql.SqliteConnection` fails at runtime with `TypeError: The "path" property must be of type string, got object`. The trigger is **any** CEL expression in an import input, not nesting specifically — nesting just forces it, because an intermediate library can only forward a received value via an expression.

Static analysis is inconsistent across the two forms, and wrong for both. A `${{ }}` import input is not checked at all (`telo check` passes silently). A `!cel` import input *is* checked — but against the wrong scope: the **child** library's variables rather than the importer's, so a valid `!cel "variables.appDb"` wrongly fails with `No such key: appDb` while the equivalent `${{ }}` passes. This contradicts the analyzer's own invariant that the two forms behave identically. In every case the error points at the wrong place — the leaf resource, or a false diagnostic — not the import line that is actually wrong.

The root inconsistency lives in [import-controller.ts](nodejs/src/controllers/module/import-controller.ts): the child context is seeded with raw `resource.variables`/`resource.secrets` at creation, while `snapshot()` already evaluates the same fields against the parent scope — the two paths disagree.

## Solution

Evaluate an import's `variables`/`secrets` against the importer's **config scope** — its own `variables` and `secrets` — replacing the verbatim bake. The importer's resolved config is what satisfies the child library's typed input contract; the library's own `variables:`/`secrets:` schema is unchanged.

Because that config is known before any resource initializes, imports never depend on resources: the import's inputs resolve from already-settled values, in plain importer-nesting order, with no fixpoint participation and no cross-module cycle modes. This deliberately scopes import inputs to config and excludes `resources.*` (see Decisions).

- **Resolve against importer config, not bake verbatim.** In `import-controller.ts`, stop seeding the child `ModuleContext` with raw compiled-value objects; evaluate `variables`/`secrets` against the importer's resolved `variables`/`secrets` — the same expansion `snapshot()` already performs. Each importer resolves its child's inputs from its own config, so values chain through arbitrary nesting depth.
- **Static type-checking of import inputs.** A dedicated `buildImportInputCelEnvironment` (`analyzer/nodejs/src/cel-environment.ts`), selected in the analyzer's per-resource CEL pass when `kind === "Telo.Import"`, types `variables`/`secrets` from the **importing** module doc (matched by `metadata.module`, not the import's own values map) and registers `resources`/`env`/`ports` as empty typed objects so referencing them is a "No such key" error. (`x-telo-context` can't be used — it only augments the always-registered scope, it can't replace it.) Both `${{ }}` and `!cel` forms route through this one env, fixing the silent `${{ }}` pass-through and the wrong-scope `!cel` false error so the two are checked identically. A library's own internal import is validated against that library in the library's standalone analysis; in the flattened app pass its module doc is absent, so the importer is undefined there and `variables`/`secrets` fall back to a permissive `map` (no false positives) while `resources`/`env` stay rejected.
- **Docs reconciliation.** Update [modules.md](docs/modules.md) (and its `pages/` mirror) to show `variables`/`secrets` flow rather than `env` in import inputs; correct the "baked verbatim" comment in `modules/s3/tests/e2e/s3-cross-module.yaml`.
- **Tests.** Regression manifests under `tests/`: config flow app→lib→lib in both `${{ }}` and `!cel` forms, and a `telo check` case asserting `${{ resources.X }}`/`${{ env.X }}` in an import input is now a load-time diagnostic.

## Decisions

- **Resolve against the importer's config scope, not bake verbatim.** Aligns the child-input binding with what `snapshot()` already evaluates; fixes the reported bug for both CEL forms.
- **Scope is `variables` + `secrets` only — `resources`, `env`, and `ports` excluded.** Exposing `resources.*` would couple an import's initialization to resource initialization, forcing imports into a split lifecycle (register kinds early, init child late) and opening cross-module cycle modes the kernel would have to detect. Config-only resolves from the importer's already-settled config *before* any resource inits, so imports stay single-phase and the kernel stays simple. Forward-compatible: widening the scope to `resources.*` later does not break any config-only manifest, so the runtime-value case (e.g. a vault-resolved secret into a library) stays recoverable if a real consumer appears. `env` is excluded as untyped, root-only, and the direction Telo is moving away from — `${{ env.X }}` in an import input becomes a static error pointing at a typed `variables` entry; `ports` is a root-only binding surface, not a value-flow concept.
- **`secrets` get identical treatment to `variables`.** A secret received by an importer (e.g. a root password bound from the host) flows through intermediate libraries to the leaf that needs it, same as a variable.
- **Ships changesets for the affected packages** (kernel, analyzer); kernel docs updated alongside the behavior.

## Complete example after the change

```yaml
# app.yaml — root supplies the db path and runs the imported migration
kind: Telo.Application
metadata: { name: my-app, version: 1.0.0 }
variables: { dbFile: { env: DB_FILE, type: string } }
imports:
  Api:
    source: ./api
    variables:
      dbFile: "${{ variables.dbFile }}"   # config flows down — now evaluated, not baked
targets: [ !ref Api.Migrate ]
```

```yaml
# api/telo.yaml — intermediate library forwards the input to a leaf
kind: Telo.Library
metadata: { name: api, version: 1.0.0 }
imports:
  Data:
    source: ../data
    variables:
      dbFile: "${{ variables.dbFile }}"   # forwarded against api's own resolved config
variables: { dbFile: { type: string } }
exports: { resources: [ Data.Migrate ] }
```

The leaf `data` library reads `${{ variables.dbFile }}` and receives the resolved path, resolved entirely from settled config before any resource initializes — no nesting depth limit, no resource ordering involved.
