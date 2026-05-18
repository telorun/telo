# Plan — Static CEL validation inside `Telo.Definition` templates

Scope: register `self` (typed from the definition's `schema:` field) and `inputs` (typed from the definition's `inputType:`) as CEL variables, walk the bodies of `Telo.Definition` resources (currently skipped wholesale by the analyzer), and validate `${{ }}` and `!cel` expressions inside `resources:`, `invoke:`, `run:`, `provide:`, top-level `inputs:`, and top-level `result:` blocks against an activation that includes those variables plus the kernel globals.

Template-body shape (aligned with how Run.Sequence steps factor dispatch from data): `invoke:` / `provide:` / `run:` describe the dispatch target only; `inputs:` (the values passed to the target) and `result:` (the post-call mapping, provide-only) live as **top-level siblings** on the definition. There is no `invoke.inputs` / `provide.inputs` / `provide.result` nested form.

Out of scope: kind-validation of resources declared inside `Telo.Definition.resources[]` (treating each template-internal resource as if it were a top-level manifest) is also out of scope — those entries are templates, not concrete resources, and `normalize-inline-resources.ts` already excludes them via `SYSTEM_KINDS`.

Prerequisite for: [`modules/mcp-client/plans/mcp-client-initial-design.md`](../../../modules/mcp-client/plans/mcp-client-initial-design.md). Sequenced **before** the kernel `provide:` plan so that when mcp-client lands, its template-defined session providers receive end-to-end static type-checking (analyzer rejects `${{ self.sesionId }}` typos at load, not at first call).

## 1. Why

Today the analyzer explicitly skips every `Telo.Definition` and `Telo.Abstract` resource at [analyzer.ts:555-557](../src/analyzer.ts#L555-L557):

```ts
if (m.kind === "Telo.Definition" || m.kind === "Telo.Abstract") {
  continue;
}
```

Consequence: the bodies of template definitions — `resources: [...]`, `invoke: {...}`, `run: "..."`, plus the new `provide: {...}` from the kernel plan — are an analyzer blind spot. Every `${{ self.X }}` / `${{ inputs.X }}` expression in [`modules/sql-repository/telo.yaml`](../../../modules/sql-repository/telo.yaml) works at runtime because the kernel template controller injects them via `expandWith` ([resource-template-controller.ts:14](../../../kernel/nodejs/src/controllers/resource-definition/resource-template-controller.ts#L14)), but a typo like `${{ self.tabel }}` (instead of `self.table`) only surfaces when the template is exercised — which for credential-style providers can be in production.

Three concrete reasons to fix this now, before the kernel `provide:` work:

1. **mcp-client's `Mcp.SqlSession` / `Mcp.StaticSession` / user-written providers are all template definitions.** They're the first place an external user is expected to author CEL against `self`. Shipping `provide:` without static `self` validation means every typo in a session provider's `inputs:` / `result:` siblings is a runtime-only failure. The whole point of pushing typed contracts down to abstracts (the [typed-abstracts.md](../../../kernel/nodejs/plans/typed-abstracts.md) work) is undone if the template body that produces the typed value is unchecked.

2. **`provide:` adds a fourth template entry-point** alongside `invoke:` / `run:` / `resources:`. Adding a new dispatch surface without analyzer coverage means each of the four targets continues to drift from manifest-author expectations. Adding analyzer coverage retroactively fixes `sql-repository` and any existing template, not just `provide:`.

3. **The kernel work expects this.** The kernel plan's §5 (typed `provide()` contract on abstracts) requires the analyzer to validate that top-level `result:` satisfies the abstract's `outputType`. That validation is incoherent without first knowing the type of `result` (the dispatched target's output) and `self` / `inputs` (the template's own field values and the caller's inputs) in the CEL activation. Sequencing this plan first lets the kernel plan reference a working analyzer surface rather than building its own ad-hoc validation.

The pieces already exist:

- `buildTypedCelEnvironment` ([cel-environment.ts](../src/cel-environment.ts)) registers typed CEL variables from JSON Schema; can register `self`, `inputs`, and `result` the same way.
- `jsonSchemaToCelType` ([schema-compat.ts:197](../src/schema-compat.ts#L197)) already maps a JSON Schema property bag to a CEL type. `Telo.Definition.schema:` and `Telo.Definition.inputType:` are exactly such property bags.
- `lookupDefinitionTypeField` ([analyzer.ts:55-67](../src/analyzer.ts#L55-L67)) already resolves a kind's `outputType` / `inputType` field for `x-telo-step-context`. Same function, new caller for `result` typing.
- `analyze` already walks every non-system manifest's field tree via `walkCelExpressions` ([analyzer.ts:635](../src/analyzer.ts#L635)). Removing the early `continue` brings template definitions into the same pipeline; the work is in supplying the correct per-scope activation.

## 2. Design

### 2.1 Both `${{ … }}` strings and `!cel` tagged scalars are validated uniformly

CEL expressions reach the analyzer in two equivalent surface forms:

```yaml
sql:      "${{ self.sql }}"             # interpolated string
bindings: !cel "self.bindings"          # YAML-tagged scalar
```

Both forms are converted to the same `CompiledValue` shape by [precompile.ts](../src/precompile.ts) — the interpolated form via `compileString`, the tagged form via the engine registry. Downstream of precompile every validator sees the same data structure regardless of how the manifest author wrote it. This is already exercised by [tagged-cel-diagnostics.test.ts](../tests/tagged-cel-diagnostics.test.ts) which proves a `makeTaggedSentinel("cel", "request.bogus")` produces the same `CEL_UNKNOWN_FIELD` diagnostic as the interpolated form.

Consequence for this plan: every analysis described below ("walk `inputs:`", "build `self` activation for `resources:`", etc.) applies to whichever form the author used. No separate code path is needed for tagged scalars — the work is in unblocking the walk into `Telo.Definition` bodies and supplying the correct `extraContextSchema`. Both forms then ride the existing chain validator transparently.

`!literal "text"` is the documented opt-out — that engine returns the raw string verbatim, so no CEL validation runs.

**Note on dispatch-target name fields.** `invoke.name` / `provide.name` may be authored as either form. For *static type-checking* we never need to resolve them to a specific `resources[]` entry — the target's `inputType` / `outputType` are keyed off `invoke.kind` / `provide.kind` (static kind names), not off the resolved name. The name field is therefore just another CEL expression validated by the chain validator like any other; no special reference-resolver path is required.

### 2.2 `self`: typed from `Telo.Definition.schema:`

For each `Telo.Definition` resource the analyzer encounters, derive a typed `self` schema from its `schema:` field:

```ts
function buildSelfSchema(definition: Record<string, any>): Record<string, any> {
  const userSchema = (definition.schema ?? {}) as Record<string, any>;
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...(userSchema.properties ?? {}),
      name: { type: "string" },                          // resource.metadata.name (convenience alias)
      kind: { type: "string" },                          // resource.kind (full kind alias)
      metadata: {                                        // so `self.metadata.name` also validates
        type: "object",
        additionalProperties: true,
        properties: { name: { type: "string" } },
      },
    },
    required: [...(userSchema.required ?? []), "name", "kind"],
  };
}
```

The runtime template controller writes `const self = { ...resource, name: resource.metadata.name };` at [resource-template-controller.ts:14](../../../kernel/nodejs/src/controllers/resource-definition/resource-template-controller.ts#L14). The synthetic `name` field is the resource's `metadata.name`; `kind` and `metadata` are already top-level on the resource via the `...resource` spread. The analyzer's schema mirrors this exactly.

**Strictness.** The schema is closed (`additionalProperties: false`) — that's the whole point of the change. CEL accesses to undeclared properties on `self` are diagnostics. The `metadata` sub-schema stays open because metadata legitimately carries arbitrary user-added fields (`description`, `version`, etc.) at runtime, but `metadata.name` is guaranteed.

### 2.3 Activations per template field

Each template field gets its own CEL activation (in addition to the always-available `variables` / `secrets` / `resources` / `env`):

| Template field | Activation extras | Sources |
| --- | --- | --- |
| `resources[].*` (any field on an internal resource) | `self`, `inputs` | `self` from definition's `schema:`; `inputs` from definition's `inputType:` |
| `invoke` (string form, name template) | `self` | `self` from definition's `schema:` |
| `invoke.kind` (object form) | none (static kind reference) | — |
| `invoke.name` (object form) | `self` | `self` from definition's `schema:` |
| `run` (string template) | `self` | `self` from definition's `schema:` |
| `provide.kind` | none (static kind reference) | — |
| `provide.name` | `self` | `self` from definition's `schema:` |
| `inputs.*` (top-level sibling — values passed to dispatch target) | `self`, `inputs` | `self` from definition's `schema:`; `inputs` from definition's `inputType:` |
| `result.*` (top-level sibling — provide-only post-call mapping) | `self`, `result` | `self` from definition's `schema:`; `result` from the dispatch target's declared `outputType` (e.g. `provide.kind`'s) |

**Sibling shape.** `invoke:` / `provide:` / `run:` describe the dispatch target. `inputs:` and `result:` are top-level siblings, matching how Run.Sequence steps factor the call (`{ name, inputs, invoke: {…} }`). There is no `invoke.inputs` / `provide.inputs` / `provide.result` nested form.

**Why `inputs` is also exposed at `resources[].*`.** At runtime the template controller passes `{ self, inputs }` when re-expanding the dispatch-target ephemeral resource ([resource-template-controller.ts](../../../kernel/nodejs/src/controllers/resource-definition/resource-template-controller.ts)). Persistent resources see only `self`. The analyzer exposes `inputs` to *every* `resources[]` entry because the target-vs-persistent distinction depends on a runtime name comparison it cannot statically resolve; permissive availability matches the most-permissive runtime case and never produces false positives.

**Where `inputs` gets its type.** Three-layer fallback, mirroring `lookupDefinitionTypeField`:

1. The definition's own `inputType:` field (preferred).
2. If absent, the `extends:`-declared abstract's `inputType:` (so a template inheriting from `Sql.RepositoryRead` gets that abstract's input contract).
3. If neither, `map<string, dyn>` — opaque, no chain validation against an unknown shape.

**Where `result` gets its type** (for `result.*`). Same fallback but the kind looked up is `provide.kind` (the dispatch target), and the field is `outputType:`.

**What the transform's own product is checked against.** Top-level `result:` as a whole, after CEL evaluation, must match the **abstract's `outputType`** (the *abstract* the definition `extends`, not the dispatch target's `outputType`). This is a structural check on the `result` object's properties — separate from the activation typing of `result` *inside* its CEL expressions. Two roles, two schemas: `result` inside `result.X` CEL = dispatch target's output (what the transform consumes); the post-evaluation value of top-level `result` = abstract's output (what the transform produces). Step 6 implements both.

### 2.4 Bringing template definitions into the walk

Two changes to [analyzer.ts](../src/analyzer.ts):

1. **Don't skip `Telo.Definition`.** Remove the early `continue` at line 555-557 for `Telo.Definition`. `Telo.Abstract` continues to be skipped — abstracts carry only `inputType:` / `outputType:` schema fields, no template body to walk, and no CEL.

2. **Activation is supplied via `x-telo-context` annotations on the `Telo.Definition` builtin schema.** The existing context-extraction pipeline already does the right thing once the annotations are in place: `extractContextsFromSchema` ([analyzer.ts:76-106](../src/analyzer.ts#L76-L106)) walks `mDefinition.schema` and produces `{ scope, schema }` pairs, then the per-expression resolver matches scopes to CEL paths. No new walker code — the work is in **§2.5** (annotation placement) and **§2.6** (root-anchored `x-telo-context-from`).

Per-kind schema validation of `resources[]` entries is **deferred**. `walkCelExpressions` still visits CEL inside them via the activations table, but the AJV/`x-telo-ref` validation that runs against top-level manifests does not extend to template-internal resources. Adding that is a separate, more invasive change — out of scope here.

### 2.5 `x-telo-context` annotations on the `Telo.Definition` builtin

The current builtin entry at [builtins.ts:39-44](../src/builtins.ts#L39-L44) is `schema: { type: "object" }`. This plan replaces it with a structured schema that **remains open** at the top level (`additionalProperties: true`) — the goal is to attach `x-telo-context` annotations to known fields, not to tighten the Telo.Definition shape itself. Tightening is a separate change.

Conceptual shape (actual code is a JS object literal in `builtins.ts`):

```yaml
kind: Telo.Definition
metadata: { name: Definition, module: Telo }
capability: Telo.Template
schema:
  type: object
  additionalProperties: true                     # keep open — see note above
  properties:
    schema:     { type: object }                 # user's instance schema; not a template body
    inputType:  { type: object }                 # typed-abstracts contract
    outputType: { type: object }
    resources:
      type: array
      items:
        type: object
        x-telo-context:                          # applies at $.resources[*] (any field within)
          type: object
          properties:
            self:   { x-telo-context-from-root: "schema" }
            inputs: { x-telo-context-from-root: "inputType" }
    invoke:
      oneOf:
        - type: string
          x-telo-context:                        # string form: the whole field is `name`
            type: object
            properties:
              self: { x-telo-context-from-root: "schema" }
        - type: object
          properties:
            kind: { type: string }
            name:
              type: string
              x-telo-context:
                type: object
                properties:
                  self: { x-telo-context-from-root: "schema" }
    provide:                                     # added by the kernel provide-template plan
      type: object
      properties:
        kind: { type: string }
        name:
          type: string
          x-telo-context:
            type: object
            properties:
              self: { x-telo-context-from-root: "schema" }
    run:
      type: string
      x-telo-context:
        type: object
        properties:
          self: { x-telo-context-from-root: "schema" }
    inputs:                                      # top-level sibling — what to pass to dispatch target
      type: object
      additionalProperties: true
      x-telo-context:
        type: object
        properties:
          self:   { x-telo-context-from-root: "schema" }
          inputs: { x-telo-context-from-root: "inputType" }
    result:                                      # top-level sibling — provide-only post-call mapping
      type: object
      additionalProperties: true
      x-telo-context:
        type: object
        properties:
          self:   { x-telo-context-from-root: "schema" }
          result: { x-telo-context-from-ref-kind: "provide/kind#outputType" }
```

Two extension points used:

- **`x-telo-context-from-root`** — a new annotation form (§2.6). Anchors path navigation at the manifest *root* (the `Telo.Definition` itself) rather than the per-scope manifest item. Unambiguous; no schema-vs-manifest-tree depth confusion.
- **`x-telo-context-from-ref-kind`** — a new annotation form for `result`. Reads a sibling field (e.g. `provide.kind`), resolves it as a kind name, and pulls a top-level field (here `outputType`) off that kind's `Telo.Definition`. Mirrors the existing `x-telo-context-ref-from` helper at [validate-cel-context.ts:99-127](../src/validate-cel-context.ts#L99-L127) but resolves through the **kind registry** instead of the manifest-name registry. The syntax is `<siblingField>#<fieldName>` — read `manifestItem.<siblingField>` as a kind name, then return that kind's `<fieldName>` schema.

### 2.6 `x-telo-context-from-root`: anchor at the manifest root

Today's [validate-cel-context.ts:81-97](../src/validate-cel-context.ts#L81-L97) resolves `x-telo-context-from` against the per-scope `manifestItem` (the array element returned by `getManifestItem`). For `self`, we need to navigate from the *root* of the manifest being analyzed (the `Telo.Definition`'s own top-level object) — not from inside `resources[0]`.

Add a sibling annotation `x-telo-context-from-root` with the same slash-path semantics as `x-telo-context-from`, but anchored at the root manifest. The resolver gains a second positional argument:

```ts
export function resolveContextAnnotations(
  schema: Record<string, any>,
  manifestItem: Record<string, any>,
  manifestRoot: Record<string, any>,           // NEW — defaults to manifestItem when caller omits
  allManifests?: Record<string, any>[],
): Record<string, any>
```

The caller at [analyzer.ts:670-678](../src/analyzer.ts#L670-L678) already has both — `m` is the root, `manifestItem` is the scoped slice. Threading the root through is a one-line change at the call site.

Why this form and not `../` parent navigation: parent navigation requires the resolver to know its position in the schema/manifest tree (currently it doesn't), and the schema-tree-depth vs. manifest-tree-depth ambiguity (an `x-telo-context` on `$.resources[*]` items: how many `../` to get to the enclosing definition?) is fragile. Root-anchored navigation has no positional state and is unambiguous: "from the top of the resource being analyzed."

### 2.7 Backward compatibility

The change moves `Telo.Definition` resources from "skipped" to "walked." Every existing template definition in the stdlib is suddenly subject to CEL validation. Two consequences:

- **Existing templates that work today might surface diagnostics.** [`modules/sql-repository/telo.yaml`](../../../modules/sql-repository/telo.yaml) is the main one — it uses both `${{ self.* }}` and `${{ inputs.* }}` patterns inside `resources[].inputs.*` and the top-level `inputs:` sibling. The activation table is designed so these continue to validate cleanly; any diagnostic that does surface indicates either (a) a latent typo or (b) an analyzer bug — both are findings worth landing. Pre-flight: run the full test suite against the stdlib before merging; any new diagnostics get investigated, not silenced.
- **User-authored templates** in any consumer manifest become validated. This is a strictly-additive behavior change for `telo check` — no previously-clean manifest gets a regression that wasn't already a bug.

## 3. Implementation steps

1. **`buildSelfSchema(definition)` helper** in [analyzer/nodejs/src/](../src/) — given a `Telo.Definition` manifest, build the typed JSON Schema for `self` per §2.2. Returns a closed object schema.

2. **Extend `resolveContextAnnotations` with `x-telo-context-from-root`** — add the new form per §2.6. Thread the root manifest through the one call site at [analyzer.ts:673](../src/analyzer.ts#L673). Add focused unit test covering nested-scope annotations resolving against the manifest root.

3. **Extend `resolveContextAnnotations` with `x-telo-context-from-ref-kind`** — read a sibling field as a kind name (via `defs.resolve` + `aliases.resolveKind`), pull `outputType` (or `inputType`) off the resolved `Telo.Definition`, return its schema. Falls back to `additionalProperties: true` (open) when the kind can't be resolved, matching the existing `x-telo-context-ref-from` posture. The resolver gains access to `defs` / `aliases` — either thread them through or do the lookup at the caller before passing the resolved schemas in.

4. **Annotate the `Telo.Definition` builtin schema** in [analyzer/builtins.ts](../src/builtins.ts) per §2.5. Keep `additionalProperties: true` on the top-level definition shape.

5. **Remove the early `continue` for `Telo.Definition` at [analyzer.ts:555-557](../src/analyzer.ts#L555-L557)**. `Telo.Abstract` stays skipped — abstracts have no template body and no CEL.

6. **Validate top-level `result` against the abstract's `outputType`** — when a definition has both `extends: <Abstract>` and `provide:`, AJV-validate the post-CEL top-level `result` object against the abstract's `outputType` schema. Separate from §2.3's `result` *activation* typing. This is the kernel-plan §5 check; landing it here keeps the analyzer surface coherent.

7. **Validate top-level `inputs` against the dispatch target's `inputType`** — when `invoke.kind` / `provide.kind` resolves to a definition with a declared `inputType`, AJV-validate the (post-CEL) `inputs` object against that schema. Parallel to step 6 but for the dispatch-target direction.

8. **Tests** (each one positive + negative):
   - `analyzer/nodejs/tests/template-self-typing.test.ts` — valid `${{ self.X }}` accepted; `${{ self.tabel }}` rejected with `CEL_UNKNOWN_FIELD`.
   - `analyzer/nodejs/tests/template-inputs-typing.test.ts` — `${{ inputs.X }}` validated against the definition's `inputType:`; typo rejected. Also covers fallback to `extends:`-declared abstract.
   - `analyzer/nodejs/tests/template-resources-walk.test.ts` — CEL inside `resources[]` entries is validated with `self` + `inputs` available.
   - `analyzer/nodejs/tests/template-invoke-target-types.test.ts` — top-level `inputs` typechecked against the dispatch target's `inputType`; mismatched shapes rejected.
   - `analyzer/nodejs/tests/template-provide-result.test.ts` — top-level `result` produces the abstract's `outputType`; `${{ result.bogus }}` rejected against the target's outputType.
   - `analyzer/nodejs/tests/template-context-from-root.test.ts` — the new `x-telo-context-from-root` annotation resolves correctly across nested scopes.
   - `analyzer/nodejs/tests/template-tagged-cel.test.ts` — tagged-form parity inside a template body:
     - Negative: `bindings: !cel "self.tabel"` produces the same `CEL_UNKNOWN_FIELD` as the interpolated form.
     - Negative: top-level `result.sessionId: !cel "result.bogus"` produces `CEL_UNKNOWN_FIELD` against the dispatch target's `outputType`.
     - Positive: `invoke.name: !cel "self.name + '-query'"` validates against `self`.
   - Smoke run of the full test suite to confirm `modules/sql-repository/` and any other stdlib templates produce no new diagnostics.

## 4. Compatibility

- **Runtime**: unchanged. The kernel template controller already passes `self` / `inputs` / `result` at runtime; the analyzer is just catching up.
- **Schema**: the `Telo.Definition` builtin gains a structured schema with `x-telo-context` annotations, but stays `additionalProperties: true`. From the user's perspective, the manifest schema for `Telo.Definition` is unchanged.
- **Existing manifests**: any latent typo inside a template surfaces as a new diagnostic. Acceptable — these are real bugs surfaced earlier.

## 5. Documentation

- Update `CLAUDE.md`'s "x-telo-* Schema Annotations" section: note `x-telo-context-from-root` (root-anchored path) and `x-telo-context-from-ref-kind` (sibling-kind output/input type lookup).
- Update the "Resource Kinds → `kind: Telo.Definition`" section: confirm template-internal CEL is statically validated against `self` (typed from `schema:`), `inputs` (typed from `inputType:`), and — inside top-level `result:` — `result` (typed from the dispatch target's `outputType`).
- Analyzer CHANGELOG entry.

## 6. Changeset

```text
"@telorun/analyzer": minor
```

Description: "Statically validate CEL expressions inside `Telo.Definition` template bodies. The analyzer now registers `self` (typed from the definition's `schema:`) and `inputs` (typed from `inputType:`) as available variables in `resources:` / `invoke:` / `run:` / `provide:` fields, catching typos at load time instead of first invocation. Adds `x-telo-context-from-root` for root-anchored context navigation and `x-telo-context-from-ref-kind` for sibling-kind type lookup."

## 7. Sequencing

This plan lands first. The kernel `provide:` plan ([provider-provide-template.md](../../../kernel/nodejs/plans/provider-provide-template.md)) then ships against a working analyzer surface — its §5 (typed `provide()` on abstracts) and §6 (analyzer changes) shrink because the prerequisite is already covered:

- The analyzer already knows `self`, `inputs`, and how to type `result` via `provide.kind`'s `outputType`. The kernel plan's analyzer work reduces to wiring the `provide:` field's structural schema (the rest is annotation-driven and already in place from this plan).
- The kernel plan's tests against top-level `inputs` / `result` (the siblings of `provide:`) rely on these activations; this plan ships them.

mcp-client follows the kernel plan and inherits full type safety end-to-end: a typo like `${{ self.sessoinId }}` in `Mcp.SqlSession`'s `provide.bindings:` is rejected by `telo check` before the manifest ever runs. The same applies to the YAML-tagged form — `bindings: !cel "self.sessoinId"` produces the identical diagnostic, since §2.1 establishes that both surface forms ride the same validator after precompile.
