# Plan — Encapsulate builtin kinds and capability rules

Scope: collapse the scattered `if (kind === "Telo.X")` checks and `SYSTEM_KINDS` sets across analyzer and kernel by (1) introducing missing parent abstracts (`Telo.Module`, `Telo.MetaKind`) so classification becomes `getByExtends` queries instead of hardcoded sets, and (2) adding capability-level rules as real properties on the capability abstracts (e.g. `throwsAllowed`, `pureType`).

Out of scope: introducing a polymorphic `BuiltinKind` class hierarchy, changing the user-visible YAML surface, refactoring runtime controllers (`module-controller.ts`, `import-controller.ts`, `resource-definition-controller.ts`).

## 1. Why

Builtin kinds today are inert metadata bags ([analyzer/nodejs/src/builtins.ts](../src/builtins.ts)). The semantics that distinguish them — "this kind is a meta-kind, skip schema validation", "this kind has no instance lifecycle", "this capability forbids `throws:`" — live as duplicated string checks in 12+ files.

The CLAUDE.md topology-driven rule already says "all resource-specific behaviour must be expressed via `x-telo-*` schema annotations" — but `x-telo-*` is the JSON Schema annotation namespace and only applies to fields that live INSIDE a `schema:` object. Behaviour that classifies the _kind itself_ (not fields of its schema) belongs as real properties on the `Telo.Definition` / `Telo.Abstract` entries. Today neither dimension is upheld for builtins. Two concrete leaks:

1. **Missing parent abstracts.** `Telo.Application` and `Telo.Library` are both module-identity docs, but no abstract expresses that — so every consumer asks `kind === "Telo.Application" || kind === "Telo.Library"` instead of `defs.getByExtends("Telo.Module")`. Same for `Telo.Definition` and `Telo.Abstract` (both meta-kinds — kinds that declare other kinds). The classification machinery (`getByExtends`) already exists; it is used by user code but not by the builtins.

2. **Capability rules live in kernel code instead of on the capability.** `Telo.Service`/`Mount`/`Provider`/`Type` forbid `throws:` — this rule is in [manifest-schemas.ts:77-126](../../../kernel/nodejs/src/manifest-schemas.ts#L77-L126) as a hand-rolled `oneOf`. `Telo.Type` resources are identified via `/\bType\b/` regex in [validate-cel-context.ts:20-24](../src/validate-cel-context.ts#L20-L24) (which incorrectly matches user kinds like `My.Type`). The capability abstracts themselves carry no fields that express these rules.

3. **`Telo.Import`'s schema is duplicated** between [analyzer/builtins.ts:46-72](../src/builtins.ts#L46-L72) and [kernel/.../import-controller.ts:163-188](../../../kernel/nodejs/src/controllers/module/import-controller.ts#L163-L188). They are identical today and nothing enforces they stay in sync.

## 2. Step 1 — Introduce parent abstracts; classification via `getByExtends`

### 2.1 Add `Telo.Module` and `Telo.MetaKind` abstracts

In [builtins.ts](../src/builtins.ts), add two new abstracts and wire the existing definitions to them via `extends`:

```ts
// New abstracts — pure classification, no schema, no lifecycle.
{ kind: "Telo.Abstract", metadata: { name: "Module",        module: "Telo" } },
{ kind: "Telo.Abstract", metadata: { name: "MetaKind", module: "Telo" } },

// Existing entries gain `extends`:
{
  kind: "Telo.Definition",
  metadata: { name: "Application", module: "Telo" },
  capability: "Telo.Template",
  extends: "Telo.Module",     // NEW
  schema: { ... },
},
{
  kind: "Telo.Definition",
  metadata: { name: "Library", module: "Telo" },
  capability: "Telo.Template",
  extends: "Telo.Module",     // NEW
  schema: { ... },
},
{
  kind: "Telo.Definition",
  metadata: { name: "Definition", module: "Telo" },
  capability: "Telo.Template",
  extends: "Telo.MetaKind",   // NEW
  schema: { type: "object" },
},
{
  kind: "Telo.Definition",
  metadata: { name: "Abstract", module: "Telo" },
  capability: "Telo.Template",
  extends: "Telo.MetaKind",   // NEW
  schema: { ... },
},
// Telo.Import — no parent abstract added; it is a single kind in its category.
```

`extends` already populates [DefinitionRegistry.extendedBy](../src/definition-registry.ts#L40-L51) — no machinery changes. `getByExtends("Telo.Module")` immediately returns `[Application, Library]`; `getByExtends("Telo.MetaKind")` returns `[Definition, Abstract]`.

### 2.2 Replace classification predicates with registry queries

Add a thin predicates module — `analyzer/nodejs/src/builtin-kinds.ts` — that wraps the registry queries so every consumer asks the same question:

```ts
import type { DefinitionRegistry } from "./definition-registry.js";

const inExtendedBy = (registry: DefinitionRegistry, parent: string, kind: string): boolean =>
  registry.getByExtends(parent).some((d) => `${d.metadata.module}.${d.metadata.name}` === kind);

export const isModuleKind = (r: DefinitionRegistry, k: string) => inExtendedBy(r, "Telo.Module", k);
export const isMetaKind = (r: DefinitionRegistry, k: string) => inExtendedBy(r, "Telo.MetaKind", k);
export const isAliasDoc = (k: string) => k === "Telo.Import"; // single kind; no abstract

// Composite predicates that today's SYSTEM_KINDS sets encode:
export const skipReferenceValidation = (r, k) => isMetaKind(r, k);
export const skipBootDAG = (r, k) => isMetaKind(r, k) || isAliasDoc(k);
export const skipResourcesMap = (r, k) => isMetaKind(r, k) || isModuleKind(r, k);
export const skipInlineNormalization = (r, k) =>
  isMetaKind(r, k) || isModuleKind(r, k) || isAliasDoc(k);
```

This file replaces [module-kinds.ts](../src/module-kinds.ts) entirely. It exposes the same function name (`isModuleKind`) but takes a registry parameter — call sites that previously held only a kind string need a registry handle.

### 2.3 Per-call-site replacements

| File:line                                                                                                | Today                                                                                                  | After                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [validate-references.ts:14,83,87](../src/validate-references.ts#L14)                                     | `SYSTEM_KINDS = new Set(["Telo.Definition", "Telo.Abstract"])`                                         | `skipReferenceValidation(registry, kind)`                                                                                                                                                                                        |
| [dependency-graph.ts:28,52,62](../src/dependency-graph.ts#L28)                                           | `SYSTEM_KINDS = new Set(["Telo.Definition", "Telo.Import"])`                                           | `skipBootDAG(registry, kind)`                                                                                                                                                                                                    |
| [normalize-inline-resources.ts:6-11,45](../src/normalize-inline-resources.ts#L6-L11)                     | `new Set(["Telo.Definition", "Telo.Application", "Telo.Library", "Telo.Import"])`                      | `skipInlineNormalization(registry, kind)`                                                                                                                                                                                        |
| [kernel-globals.ts:16-21,54](../src/kernel-globals.ts#L16-L21)                                           | `new Set(["Telo.Definition", "Telo.Application", "Telo.Library", "Telo.Abstract"])`                    | `skipResourcesMap(registry, kind)`                                                                                                                                                                                               |
| [kernel-globals.ts:40-46](../src/kernel-globals.ts#L40-L46)                                              | `find(m => m.kind === "Telo.Application") ?? find(m => m.kind === "Telo.Library")`                     | unchanged — the Application-preferred semantics is itself a per-kind discriminator; `isModuleKind` doesn't carry that ordering                                                                                                   |
| [analyzer.ts:451-457](../src/analyzer.ts#L451-L457)                                                      | `isModuleKind(m.kind)` (from module-kinds.ts)                                                          | `isModuleKind(registry, m.kind)` (from builtin-kinds.ts)                                                                                                                                                                         |
| [analyzer.ts:481](../src/analyzer.ts#L481)                                                               | `m.kind === "Telo.Import"`                                                                             | `isAliasDoc(m.kind)`                                                                                                                                                                                                             |
| [analyzer.ts:525,574](../src/analyzer.ts#L525)                                                           | `m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract"` (twice)                                   | `!isMetaKind(registry, m.kind)`                                                                                                                                                                                                  |
| [validate-extends.ts:49](../src/validate-extends.ts#L49)                                                 | `m.kind !== "Telo.Import"`                                                                             | `!isAliasDoc(m.kind)`                                                                                                                                                                                                            |
| [validate-extends.ts:55,122](../src/validate-extends.ts#L55)                                             | direct `Telo.Definition` / `Telo.Abstract` checks                                                      | unchanged — these are semantic ("this validator only operates on definitions") not classification                                                                                                                                |
| [validate-throws-coverage.ts:442](../src/validate-throws-coverage.ts#L442)                               | `m.kind !== "Telo.Definition"`                                                                         | unchanged — this validator inspects `throws:` on definitions specifically                                                                                                                                                        |
| [validate-throws-coverage.ts:501](../src/validate-throws-coverage.ts#L501)                               | `manifest.kind === "Telo.Definition" \|\| manifest.kind === "Telo.Abstract"`                           | `isMetaKind(registry, manifest.kind)`                                                                                                                                                                                            |
| [kind-suggest.ts:6-15](../src/kind-suggest.ts#L6-L15)                                                    | `ROOT_KINDS`, `ABSTRACT_DEF_KINDS`                                                                     | `getByExtends("Telo.MetaKind")` for the abstract set; `ROOT_KINDS` stays as a small literal list (it's the user-completion seed, not a classification question)                                                                  |
| [kernel.ts:218](../../../kernel/nodejs/src/kernel.ts#L218)                                               | `rootModuleDoc?.kind === "Telo.Library"`                                                               | unchanged — single literal check, semantic ("reject Library as root manifest")                                                                                                                                                   |
| [kernel.ts:261](../../../kernel/nodejs/src/kernel.ts#L261)                                               | `isModuleKind(manifest.kind)`                                                                          | `isModuleKind(registry, manifest.kind)`                                                                                                                                                                                          |
| [import-controller.ts:69-78](../../../kernel/nodejs/src/controllers/module/import-controller.ts#L69-L78) | `find(m => m.kind === "Telo.Library")` then `find(m => m.kind === "Telo.Application")`                 | unchanged — both sides of the discriminator name a single kind                                                                                                                                                                   |
| [manifest-loader.ts:18-23,211](../src/manifest-loader.ts#L18-L23)                                        | `SYSTEM_KINDS = {Application, Library, Import, Definition}` — kinds forbidden in partial include files | Stays as a small literal set — single call site, distinct concept ("forbidden in partials"), no clean topology mapping (Definition is forbidden but Abstract is allowed). Worth a comment explaining why this one stays literal. |

### 2.4 Checks that stay as literal kind comparisons, by design

- `isAliasDoc(k)` — `Telo.Import` is the only kind in its category. Adding a `Telo.AliasDoc` abstract for one extender is over-engineering.
- "Is this Application?" / "Is this Library?" — each names a single kind. Predicates over a registry pay off when multiple kinds share an answer; with one kind / one or two call sites each, `kind === "Telo.Application"` is the more honest expression than a `canBeRoot` flag whose only setter is Application.
- `manifest-loader.ts`'s "forbidden in partials" set — single call site, doesn't map cleanly onto the meta-kind / module taxonomy (Telo.Definition forbidden, Telo.Abstract allowed). Keeping it literal makes the asymmetry visible rather than hiding it behind a flag.

All are documented as deliberate exceptions in the predicates module's file header.

### 2.5 Threading the registry

Most call sites already have a `DefinitionRegistry` in scope (every analyzer pass takes one; the kernel constructs one). Three sites need a parameter added:

- `kernel.ts:218` — `this.registry` is already a member
- `import-controller.ts:69-78` — `ctx.getDefinition` exists; pass through or expose a `ctx.registry`
- `analyzer.ts` — already constructs and passes the registry

No new dependency injection. No new public API beyond the predicates module.

## 3. Step 2 — Capability rules as properties on the abstract

### 3.1 Add fields to the capability abstracts in `builtins.ts`

`Telo.Provider`'s existing `schema: { "x-telo-eval": "compile" }` stays as-is — that is a real `x-telo-*` annotation correctly placed inside a `schema:` object (it tells the analyzer to compile-evaluate the fields of any Provider's config). For rules that classify the _capability itself_, add unprefixed properties on the abstract entry:

```ts
{ kind: "Telo.Abstract", metadata: { name: "Service",   module: "Telo" }, throwsAllowed: false },
{ kind: "Telo.Abstract", metadata: { name: "Runnable",  module: "Telo" }, throwsAllowed: true },
{ kind: "Telo.Abstract", metadata: { name: "Invocable", module: "Telo" }, throwsAllowed: true },
{ kind: "Telo.Abstract", metadata: { name: "Provider",  module: "Telo" }, throwsAllowed: false, schema: { "x-telo-eval": "compile" } },
{ kind: "Telo.Abstract", metadata: { name: "Mount",     module: "Telo" }, throwsAllowed: false },
{ kind: "Telo.Abstract", metadata: { name: "Type",      module: "Telo" }, throwsAllowed: false, pureType: true },
{ kind: "Telo.Abstract", metadata: { name: "Template",  module: "Telo" } },
```

The `ResourceDefinition` interface in [sdk/nodejs/src/types.ts:33-54](../../../sdk/nodejs/src/types.ts#L33-L54) gains optional fields: `throwsAllowed?: boolean`, `pureType?: boolean`. The validator schemas in `manifest-schemas.ts` reject these fields on user-written manifests — they are kernel-internal classification data, only set on the seeded builtin entries.

### 3.2 Derive `manifest-schemas.ts` `oneOf` from the registry

[manifest-schemas.ts:77-126](../../../kernel/nodejs/src/manifest-schemas.ts#L77-L126) hardcodes a `KNOWN_CAPABILITIES` array and a 35-line `oneOf`. After:

```ts
import { KERNEL_BUILTINS } from "@telorun/analyzer/builtins";

const builtinCapabilities = KERNEL_BUILTINS.filter(
  (d) =>
    d.kind === "Telo.Abstract" && d.metadata.module === "Telo" && d.metadata.name !== "Template",
);
const knownCapabilityKinds = builtinCapabilities.map((c) => `Telo.${c.metadata.name}`);

const oneOfBranches = builtinCapabilities.map((cap) => {
  const kind = `Telo.${cap.metadata.name}`;
  const branch: any = { required: ["capability"], properties: { capability: { const: kind } } };
  if ((cap as any).throwsAllowed === false) Object.assign(branch, forbidThrows);
  return branch;
});
oneOfBranches.push({
  not: { required: ["capability"], properties: { capability: { enum: knownCapabilityKinds } } },
  unevaluatedProperties: true,
});

export const ResourceDefinitionSchema = { ...baseDefinition, oneOf: oneOfBranches };
```

35 lines collapse to ~12. Adding a 7th capability becomes one line in `builtins.ts`.

`KERNEL_BUILTINS` needs to be exported from the analyzer's public entry. Add to `analyzer/nodejs/src/index.ts`.

### 3.3 Fix `validate-cel-context.ts` `\bType\b` regex

Today [validate-cel-context.ts:9-26](../src/validate-cel-context.ts#L9-L26) has no registry access, so it falls back to a name regex that incorrectly matches user kinds containing "Type" as a path segment. Threading the registry in:

```ts
export function resolveTypeFieldToSchema(
  value: unknown,
  allManifests: Record<string, any>[],
  registry: DefinitionRegistry,
) {
  ...
  const typeManifest = allManifests.find(m => {
    if ((m.metadata as any)?.name !== value) return false;
    const def = registry.resolve(m.kind);
    if (!def) return false;
    // Walk the definition's capability chain looking for pureType.
    return capabilityHasFlag(def, "pureType", registry);
  });
  ...
}
```

`capabilityHasFlag` walks the `extends`/`capability` chain via `registry.resolve` until it finds the flag or runs out of parents. This is the same pattern Telo uses elsewhere for capability inheritance.

### 3.4 Delete the duplicated `Telo.Import` schema

[import-controller.ts:163-188](../../../kernel/nodejs/src/controllers/module/import-controller.ts#L163-L188) re-declares `Telo.Import`'s schema. Replace with a re-export of the canonical entry:

```ts
import { KERNEL_BUILTINS } from "@telorun/analyzer/builtins";
export const schema = KERNEL_BUILTINS.find(
  (d) =>
    d.kind === "Telo.Definition" && d.metadata.name === "Import" && d.metadata.module === "Telo",
)!.schema;
```

Or, if the runtime kernel doesn't actually consume `import-controller.ts`'s `export const schema` (resource-definition-controller validates via `validateResourceDefinition` against the canonical builtin), delete outright. Verification needed in PR 3.

## 4. Impact summary

### Files touched

| Change                                 | Files modified                                                                                                | Files deleted                                          | Files added            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------- |
| Step 1 (parent abstracts + predicates) | 9 analyzer + 2 kernel = 11                                                                                    | 1 (`module-kinds.ts` → folded into `builtin-kinds.ts`) | 1 (`builtin-kinds.ts`) |
| Step 2 (capability annotations)        | 3 (`builtins.ts`, `manifest-schemas.ts`, `validate-cel-context.ts`); possibly 1 more (`import-controller.ts`) | 0                                                      | 0                      |

Total: ~13 files modified, 1 added, 1 deleted/folded. No public YAML surface changes. No runtime behavior changes for valid manifests except the `\bType\b` fix (which only affects manifests where the regex was producing false positives).

### Lines moved (rough)

- `builtin-kinds.ts`: ~40 lines (predicates + composite predicates; smaller than the descriptor-table version because the registry already does the lookups)
- `builtins.ts`: +10 lines (2 new abstracts, 4 `extends` fields, 7 capability properties: 6 `throwsAllowed` + 1 `pureType`)
- `sdk/nodejs/src/types.ts`: +2 lines (2 optional fields on `ResourceDefinition`: `throwsAllowed`, `pureType`)
- `module-kinds.ts`: -7 lines (deleted)
- 5 SYSTEM_KINDS / ROOT_KINDS declarations: -25 lines
- `manifest-schemas.ts` `oneOf`: -23 lines (35 hand-rolled → 12 derived)
- `import-controller.ts` schema: -25 lines
- Per-call-site changes: 1 line each across 14 sites

Net: noticeably fewer lines, substantially fewer literal kind strings (the actual goal). Eight remaining literal `"Telo.X"` checks (down from ~30), each with a documented reason for being literal.

### Test impact

No existing test changes behavior. New tests:

1. `analyzer/tests/parent-abstracts.test.yaml` — verify `getByExtends("Telo.Module")` returns Application + Library; same for MetaKind. This is the contract test for Step 1.
2. `analyzer/tests/capability-throws-rule.test.yaml` — a `Telo.Service` definition with `throws:` is rejected; same for Mount/Provider/Type. Contract test for Step 2.
3. `analyzer/tests/type-resolution.test.yaml` — a user kind named `My.Type` (not `extends: Telo.Type`) is NOT treated as a `Telo.Type` instance. Regression guard for Step 3.3.
4. Existing `pnpm run test` suite must pass unchanged.

## 5. Migration sequence

Three sequential PRs, each independently revertible:

1. **PR 1 — Parent abstracts and predicates.** Add `Telo.Module` / `Telo.MetaKind` to `builtins.ts`, add `extends` to existing entries. Add `builtin-kinds.ts` with the predicate functions. Replace the call sites that fold into the umbrella predicates. Delete `module-kinds.ts`. No semantic change.

2. **PR 2 — Capability properties.** Add `throwsAllowed` and `pureType` fields to capability abstracts in `builtins.ts` (with matching `ResourceDefinition` interface additions). Derive `manifest-schemas.ts:oneOf` from the registry. Add the contract test from 4.3.2.

3. **PR 3 — `\bType\b` fix and `Telo.Import` schema dedup.** Both depend on PR 2's annotations being in place. One small PR each is fine.

PR 1 is structural. PR 2 is the substantive encapsulation win. PR 3 mops up. Each is bounded and reviewable.

## 6. What this plan deliberately does not do

- **No `BuiltinKind` class hierarchy.** Predicates over the registry give the same encapsulation with less indirection.
- **No new `x-telo-*` schema annotations.** The new flags (`throwsAllowed`, `pureType`) are real top-level properties on the abstract entries, not JSON Schema annotations. The `x-telo-*` namespace stays scoped to its actual purpose: annotations on fields _inside_ a `schema:` object (like the existing `Telo.Provider.schema["x-telo-eval"]`).
- **No restructuring of controllers.** `module-controller.ts`, `import-controller.ts`, `resource-definition-controller.ts`, `abstract-controller.ts` are unchanged. One controller per kind is exactly the encapsulation you want at the runtime tier.
- **No `Telo.AliasDoc` abstract.** Telo.Import is the single member of its category; an abstract for one extender is over-engineering.

## 7. Open questions

1. **Should the new `x-telo-*` flags be inheritable through `extends`?** A user definition with `extends: Self.MyModule` (where `MyModule extends Telo.Module`) — should it inherit module-kind semantics? The `getByExtends` machinery already walks transitively, so the answer is implicitly "yes." But this means user code can extend `Telo.Module` and become a module-identity doc, which is probably not desirable. Two paths: (a) accept it as a side effect (CLAUDE.md says everything is on the table — module identities themselves could become user-extensible), or (b) gate "is this a builtin classification abstract" by `metadata.module === "Telo"` in the predicates. Recommend (b) for now; revisit if a real use case emerges.

2. **Where does `KERNEL_BUILTINS` get exported from?** Currently it's an internal of `@telorun/analyzer`. PR 2 needs the kernel to import it. Option A: re-export from `analyzer/src/index.ts`. Option B: move to `@telorun/sdk`. Recommend A — minimal change, kernel already depends on analyzer.

3. **If more module subtypes ever appear, the per-kind discriminators (Application = root, Library = import) become a real classification question.** Today they are single-kind facts and stay as literal `kind === "..."` checks at one or two call sites each. If a third module subtype lands, revisit: either add `Telo.RootModule` / `Telo.ImportableModule` abstracts or add `canBeRoot` / `canBeImported` boolean fields on the definitions. Don't pre-pay either cost now.
