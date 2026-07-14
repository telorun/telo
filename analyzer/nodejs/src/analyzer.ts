import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { canonicalTypeSchemaId } from "@telorun/sdk";
import type { Environment } from "@marcbachmann/cel-js";
import { defaultRegistry, isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import { AliasResolver, scopeResolverForModule } from "./alias-resolver.js";
import { AnalysisRegistry } from "./analysis-registry.js";
import {
  buildCelEnvironment,
  buildImportInputCelEnvironment,
  buildTypedCelEnvironment,
  type CelHandlers,
} from "./cel-environment.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { effectiveAuthorSchema } from "./extends-resolution.js";
import { buildDependencyGraph, formatCycle } from "./dependency-graph.js";
import { buildKernelGlobalsSchema, mergeKernelGlobalsIntoContext } from "./kernel-globals.js";
import { computeSuggestKind } from "./kind-suggest.js";
import { visitManifest } from "./manifest-visitor.js";
import { isModuleKind } from "./module-kinds.js";
import { normalizeInlineResources } from "./normalize-inline-resources.js";
import { REF_VALIDATION_SKIP_KINDS } from "./system-kinds.js";
import { resolveRefSentinels } from "./resolve-ref-sentinels.js";
import { resolveSchemaTypeRefs } from "./resolve-schema-type-refs.js";
import { validateSchemaTypeRefs } from "./validate-schema-type-refs.js";
import { rewriteSyntheticOrigins } from "./rewrite-synthetic-origins.js";
import {
  celTypeSatisfiesJsonSchema,
  substituteCelFields,
  validateAgainstSchema,
  type SchemaIssue,
} from "./schema-compat.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type AnalysisOptions } from "./types.js";
import {
  extractCelRegionScopes,
  extractContextsFromSchema,
  getManifestItem,
  pathMatchesScope,
  resolveContextAnnotations,
  resolveTypeFieldToSchema,
} from "./validate-cel-context.js";
import { buildEvalPaths, evalPathsCover } from "./eval-paths.js";
import { validateExtends } from "./validate-extends.js";
import { validateBaseMapping } from "./validate-base-mapping.js";
import { validateNestedInlineResources } from "./validate-nested-inline.js";
import { validateKindDescriptions } from "./validate-kind-descriptions.js";
import { validateProviderCoherence } from "./validate-provider-coherence.js";
import { validateReferences } from "./validate-references.js";
import { validateReferenceForms } from "./validate-reference-forms.js";
import { validateUnusedDeclarations } from "./validate-unused-declarations.js";
import { validateThrowsCoverage } from "./validate-throws-coverage.js";

const SELF_PREFIX = "Self.";

/**
 * `StaticAnalyzer.analyze()` requires `metadata.source` (non-empty) and
 * `metadata.sourceLine` (number) on every non-system manifest — see the
 * JSDoc on `analyze()`. Production callers stamp these via the `Loader` /
 * `flattenForAnalyzer` / `emitDocsFor` paths; programmatic callers (tests,
 * scripts) should pre-process inputs with `withSyntheticPositions(...)`.
 * Surfacing the violation here turns silent dedup misbehaviour into a
 * loud, actionable error.
 */
function assertManifestPositions(manifests: ResourceManifest[]): void {
  for (let i = 0; i < manifests.length; i++) {
    const m = manifests[i];
    if (REF_VALIDATION_SKIP_KINDS.has(m.kind)) continue;
    const meta = m.metadata as { source?: string; sourceLine?: number } | undefined;
    const okSource = typeof meta?.source === "string" && meta.source.length > 0;
    const okLine = typeof meta?.sourceLine === "number";
    if (okSource && okLine) continue;
    const label = `${m.kind}/${m.metadata?.name ?? "(unnamed)"}`;
    const missing = [
      !okSource ? "metadata.source" : null,
      !okLine ? "metadata.sourceLine" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    throw new Error(
      `StaticAnalyzer.analyze(): manifest #${i} (${label}) is missing ${missing}. ` +
        `Real callers stamp positions automatically; programmatic callers ` +
        `(tests, ad-hoc scripts) should pass inputs through ` +
        `\`withSyntheticPositions(manifests)\` before calling analyze().`,
    );
  }
}

/** Resolve an alias-prefixed kind value (e.g. `Self.Encoder` or `Ai.Model`)
 *  to its canonical form. `Self.<Name>` resolves to `<ownModule>.<Name>` —
 *  the magic alias for "this library's own module" — and other prefixes
 *  resolve through the declaring file's Telo.Import aliases. */
function resolveSelfOrAlias(
  value: string,
  ownModule: string | undefined,
  scopeResolver: AliasResolver,
): string | undefined {
  if (value.startsWith(SELF_PREFIX) && ownModule) {
    return `${ownModule}.${value.slice(SELF_PREFIX.length)}`;
  }
  return scopeResolver.resolveKind(value);
}

/** Look up a top-level field (`outputType`, `inputType`) on a kind's
 *  `Telo.Definition`. Used as a fallback by `buildStepContextSchema` when the
 *  invoked resource manifest doesn't carry the field inline — most kinds
 *  declare result shape on the definition, not the resource. */
function lookupDefinitionTypeField(
  invokedKind: string,
  fieldName: string,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  allManifests: Record<string, any>[],
): Record<string, any> | undefined {
  const canonical = aliases.resolveKind(invokedKind) ?? invokedKind;
  const def = defs.resolve(canonical);
  if (!def) return undefined;
  const value = (def as unknown as Record<string, unknown>)[fieldName];
  return resolveTypeFieldToSchema(value, allManifests);
}

const SOURCE = "telo-analyzer";

/** Build a closed JSON Schema for the `self` CEL variable available inside a
 *  `Telo.Definition` template body. Mirrors the runtime template controller's
 *  `const self = { ...resource, name: resource.metadata.name };` — every
 *  property the user declared in `schema:` plus synthetic `name` / `kind` and
 *  the metadata sub-object (kept open since metadata legitimately carries
 *  arbitrary user-added fields). */
function buildSelfSchema(
  definition: Record<string, any>,
  defs?: DefinitionRegistry,
  aliases?: AliasResolver,
): Record<string, any> {
  // The author-facing schema resolves inheritance: with `base:` the child's own
  // schema (the parent's config is internal); without it, `merge(parent, own)`.
  const userSchema = (
    defs
      ? effectiveAuthorSchema(definition as unknown as ResourceDefinition, (k) =>
          defs.resolve(aliases?.resolveKind(k) ?? k) ?? defs.resolve(k),
        )
      : (definition.schema ?? {})
  ) as Record<string, any>;
  const userProps = (userSchema.properties ?? {}) as Record<string, any>;
  const userRequired = Array.isArray(userSchema.required) ? userSchema.required : [];
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...userProps,
      name: { type: "string" },
      kind: { type: "string" },
      metadata: {
        type: "object",
        additionalProperties: true,
        properties: { name: { type: "string" } },
      },
    },
    required: [...userRequired, "name", "kind"],
  };
}

/** Build the JSON Schema for the `inputs` CEL variable available inside an
 *  invocable template body. Three-layer fallback mirroring the runtime's
 *  caller-supplied inputs:
 *    1. The definition's own `inputType:` field (preferred).
 *    2. The `extends:`-declared abstract's `inputType:` (so a concrete
 *       definition inheriting a contract gets typed inputs without
 *       redeclaring them).
 *    3. Undefined — caller signals opaque `map<string, dyn>` upstream. */
function lookupTemplateInputsSchema(
  definition: Record<string, any>,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  allManifests: Record<string, any>[],
): Record<string, any> | undefined {
  const own = resolveTypeFieldToSchema(definition.inputType, allManifests);
  if (own) return own;
  const ext = definition.extends as string | undefined;
  if (typeof ext === "string" && ext.length > 0) {
    const canonical = aliases.resolveKind(ext) ?? ext;
    const abstractDef = defs.resolve(canonical);
    if (abstractDef) {
      const inherited = resolveTypeFieldToSchema(
        (abstractDef as unknown as Record<string, unknown>).inputType,
        allManifests,
      );
      if (inherited) return inherited;
    }
  }
  return undefined;
}

/** Returns a "resolver-facing" view of the manifest where the fields used as
 *  navigation roots by Telo.Definition's `x-telo-context-from-root` annotations
 *  have been pre-augmented:
 *    - `schema`     → augmented `self` schema (synthetic `name`/`kind`/metadata).
 *    - `inputType`  → resolved with extends fallback when the field isn't
 *                     declared directly on the definition.
 *
 *  For non-definition manifests the original object is returned. */
function manifestRootForResolver(
  m: Record<string, any>,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  allManifests: Record<string, any>[],
): Record<string, any> {
  if (m.kind !== "Telo.Definition") return m;
  const inputs = lookupTemplateInputsSchema(m, defs, aliases, allManifests);
  return {
    ...m,
    schema: buildSelfSchema(m, defs, aliases),
    ...(inputs ? { inputType: inputs } : {}),
  };
}

/** Resolve a local `$ref` (only `#/$defs/<name>` form) against the root schema.
 *  Non-refs and unresolved refs pass through unchanged. */
function resolveLocalRef(
  schema: Record<string, any> | undefined,
  root: Record<string, any>,
): Record<string, any> | undefined {
  if (!schema) return undefined;
  const ref = schema.$ref;
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    const defName = ref.slice("#/$defs/".length);
    const resolved = root.$defs?.[defName];
    if (resolved && typeof resolved === "object") return resolved as Record<string, any>;
  }
  return schema;
}

/** Gather property schemas from a (possibly variant-bearing) object schema:
 *  top-level `properties` plus every `oneOf` / `anyOf` / `allOf` branch. */
function gatherPropertySchemas(schema: Record<string, any>): Array<[string, Record<string, any>]> {
  const out: Array<[string, Record<string, any>]> = [];
  if (schema.properties && typeof schema.properties === "object") {
    for (const [k, v] of Object.entries(schema.properties as Record<string, any>)) {
      out.push([k, v as Record<string, any>]);
    }
  }
  for (const variantKey of ["oneOf", "anyOf", "allOf"] as const) {
    const arr = schema[variantKey];
    if (!Array.isArray(arr)) continue;
    for (const variant of arr) {
      if (variant && typeof variant === "object" && variant.properties) {
        for (const [k, v] of Object.entries(variant.properties as Record<string, any>)) {
          out.push([k, v as Record<string, any>]);
        }
      }
    }
  }
  return out;
}

/**
 * Generic, role-driven walk over an `x-telo-step-context` step array. Calls
 * `visit(step, stepPath)` for every step — top-level and nested through the
 * `x-telo-topology-role` forms (`branch`, `branch-list`, `case-map`). This is
 * the single definition of how steps nest, shared by `buildStepContextSchema`
 * (which types `steps.<name>.result`) and `validateStepInvokeReferences` (which
 * checks invoke refs), so the topology contract lives in one place — adding a
 * role or nesting form updates both consumers at once. No resource kind is
 * hardcoded; recursion is driven entirely by the schema annotations.
 */
function walkStepArray(
  steps: unknown[],
  stepItemSchema: Record<string, any> | undefined,
  rootSchema: Record<string, any>,
  basePath: string,
  visit: (step: Record<string, any>, stepPath: string) => void,
): void {
  const dispatchRole = (
    data: unknown,
    role: string,
    itemsSchema: Record<string, any> | undefined,
    path: string,
  ): void => {
    if (role === "branch" && Array.isArray(data)) {
      walkStepArray(data, stepItemSchema, rootSchema, path, visit);
    } else if (role === "case-map" && data && typeof data === "object" && !Array.isArray(data)) {
      for (const [caseKey, arr] of Object.entries(data as Record<string, unknown>)) {
        if (Array.isArray(arr)) walkStepArray(arr, stepItemSchema, rootSchema, `${path}.${caseKey}`, visit);
      }
    } else if (role === "branch-list" && Array.isArray(data)) {
      const entrySchema = resolveLocalRef(itemsSchema, rootSchema);
      if (!entrySchema) return;
      data.forEach((entry, i) => {
        if (!entry || typeof entry !== "object") return;
        for (const [subKey, subSchema] of gatherPropertySchemas(entrySchema)) {
          const subRole = subSchema["x-telo-topology-role"];
          if (typeof subRole !== "string") continue;
          dispatchRole(
            (entry as Record<string, any>)[subKey],
            subRole,
            subSchema.items as Record<string, any> | undefined,
            `${path}[${i}].${subKey}`,
          );
        }
      });
    }
  };

  steps.forEach((step, i) => {
    if (!step || typeof step !== "object") return;
    const s = step as Record<string, any>;
    const stepPath = `${basePath}[${i}]`;
    visit(s, stepPath);
    if (!stepItemSchema) return;
    for (const [propKey, propSchema] of gatherPropertySchemas(stepItemSchema)) {
      const role = propSchema["x-telo-topology-role"];
      if (typeof role !== "string") continue;
      dispatchRole(
        s[propKey],
        role,
        propSchema.items as Record<string, any> | undefined,
        `${stepPath}.${propKey}`,
      );
    }
  });
}

/**
 * Build a `steps` context schema from `x-telo-step-context` annotation.
 * Walks each step in the manifest array, resolves the invoked resource's outputType,
 * and builds `steps.<name>.result` context entries.
 *
 * outputType resolution falls through three layers:
 *   1. The invoked resource manifest's own `outputType` field (rare — most
 *      resources don't declare outputType inline).
 *   2. The kind's `Telo.Definition` outputType (the common case for kinds that
 *      declare a stable result shape, e.g. `Ai.TextStream` ↦ `{output: stream}`).
 *   3. Permissive `{type: object, additionalProperties: true}` if neither
 *      yields a schema.
 *
 * Layer 2 is what makes `x-telo-stream` properties on definitions actually
 * govern step-result chain validation — without it, the validator falls back
 * to permissive and the stream-opacity rule never fires.
 *
 * Recursion into nested step arrays is annotation-driven via
 * `x-telo-topology-role`. The analyzer recognises three role values:
 *   - `branch`     — value is an array of steps (e.g. then / else / do / catch).
 *   - `branch-list`— value is an array of objects each carrying further roled
 *                    sub-properties (e.g. elseif: [{ if, then }]).
 *   - `case-map`   — value is an object whose values are step arrays (e.g. cases).
 * No specific Run.Sequence field name is hardcoded; any kind that uses
 * `x-telo-step-context` and tags its branch fields with these roles works.
 */
function buildStepContextSchema(
  manifest: Record<string, any>,
  defSchema: Record<string, any>,
  allManifests: Record<string, any>[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
): Record<string, any> | undefined {
  const props = defSchema.properties as Record<string, any> | undefined;
  if (!props) return undefined;

  for (const [fieldName, fieldSchema] of Object.entries(props)) {
    const stepCtx = fieldSchema["x-telo-step-context"] as Record<string, string> | undefined;
    if (!stepCtx) continue;

    const invokeField = stepCtx.invoke;
    const outputTypeField = stepCtx.outputType;
    if (!invokeField || !outputTypeField) continue;

    const steps = manifest[fieldName];
    if (!Array.isArray(steps)) continue;

    const stepItemSchema = resolveLocalRef(
      fieldSchema.items as Record<string, any> | undefined,
      defSchema,
    );

    const stepProperties: Record<string, any> = {};

    walkStepArray(steps, stepItemSchema, defSchema, fieldName, (s) => {
      const name = s.name;
      const invoke = s[invokeField] as Record<string, any> | undefined;
      // Only invoke steps register a `steps.<name>.result` entry — control-flow
      // wrappers (try/if/while/switch/throw) don't produce a result and must
      // not shadow real entries with a permissive `additionalProperties: true`,
      // or unknown step references slip through chain validation.
      if (typeof name !== "string" || !invoke || typeof invoke !== "object") return;
      let outputSchema: Record<string, any> | undefined;
      const invokedKind = invoke.kind as string | undefined;
      const invokedName = invoke.name as string | undefined;
      if (invokedName) {
        const invokedManifest = allManifests.find(
          (m) =>
            (m.metadata as any)?.name === invokedName &&
            (!invokedKind || m.kind === invokedKind),
        ) as Record<string, any> | undefined;
        if (invokedManifest) {
          outputSchema = resolveTypeFieldToSchema(invokedManifest[outputTypeField], allManifests);
        }
      } else {
        outputSchema = resolveTypeFieldToSchema(invoke[outputTypeField], allManifests);
      }
      // Fallback: pull outputType from the kind's Telo.Definition. The
      // resource manifest typically doesn't carry outputType; the def does.
      if (!outputSchema && invokedKind) {
        outputSchema = lookupDefinitionTypeField(
          invokedKind,
          outputTypeField,
          defs,
          aliases,
          allManifests,
        );
      }
      stepProperties[name] = {
        type: "object",
        properties: {
          result: outputSchema ?? { type: "object", additionalProperties: true },
        },
      };
    });

    if (Object.keys(stepProperties).length > 0) {
      return {
        type: "object",
        properties: stepProperties,
      };
    }
  }

  return undefined;
}

/**
 * Capabilities whose instances structurally expose no `invoke`/`run` method, so
 * a step `invoke` of one always fails at runtime with ERR_RESOURCE_NOT_INVOKABLE
 * (kernel dispatch checks method presence, not capability — evaluation-context.ts).
 * `Telo.Service` is intentionally absent: some services are invocable (a function
 * handler dispatched directly, e.g. `Lambda.Function`), so it can't be rejected
 * statically without false positives. This is the sound subset of the runtime rule.
 */
const NON_INVOKABLE_CAPABILITIES = new Set([
  "Telo.Provider",
  "Telo.Mount",
  "Telo.Type",
  "Telo.Template",
]);

/**
 * Validate `x-telo-step-context` step `invoke` references (e.g. `Run.Sequence`
 * steps).
 *
 * The reference field map deliberately does NOT descend into step `invoke`
 * slots — they sit behind a local `$ref` to the shared step definition, and
 * turning the descent on would make Phase 5 inject live instances there,
 * breaking the invoke dispatch path (see `reference-field-map.ts`). A
 * consequence is that `validateReferences` never sees these slots, so a bad
 * step invoke passes `telo check` and only fails at runtime. This pass covers
 * exactly those slots, in two dimensions:
 *   - Existence: an `invoke: !ref <name>` that names a missing instance — or a
 *     *kind* instead of an exported instance (`!ref Stream.Of`) — is a still-a-
 *     sentinel after Phase 2.5 resolution → `UNRESOLVED_REFERENCE` (runtime
 *     `ERR_RESOURCE_NOT_FOUND`).
 *   - Invokability: a resolved instance whose capability structurally has no
 *     invoke/run method (`NON_INVOKABLE_CAPABILITIES`) → `REFERENCE_KIND_MISMATCH`
 *     (runtime `ERR_RESOURCE_NOT_INVOKABLE`).
 *
 * Generic and topology-driven — it walks steps via the same `x-telo-step-context`
 * / `x-telo-topology-role` annotations `buildStepContextSchema` uses (through the
 * shared `walkStepArray`), so nested branches (then/else/do/catch/cases) are
 * covered and no `Run.Sequence` field name is hardcoded. The cross-module
 * partial-analysis guard mirrors `validateReferences`, so a reference into an
 * unloaded import is skipped rather than false-flagged.
 */
function validateStepInvokeReferences(
  allManifests: Record<string, any>[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];

  // Local instance names + loaded-module set — same construction as
  // validateReferences, so the cross-module guard behaves identically.
  const localNames = new Set<string>();
  const loadedModules = new Set<string>();

  // Also collect names of resources nested inside a manifest tree — notably
  // `with:`-scoped resources (an `x-telo-scope` region the field map does not
  // extract to a top-level manifest). A step can invoke one by bare name, so
  // omitting them would false-flag a valid `!ref`. Conservative: any nested
  // object carrying both a `kind` and a `metadata.name` is a resource
  // definition; scope visibility is left to the runtime.
  const collectNestedNames = (value: unknown): void => {
    if (!value || typeof value !== "object" || isTaggedSentinel(value)) return;
    if (Array.isArray(value)) {
      for (const item of value) collectNestedNames(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    const name = (obj.metadata as { name?: unknown } | undefined)?.name;
    if (typeof obj.kind === "string" && typeof name === "string") localNames.add(name);
    for (const v of Object.values(obj)) collectNestedNames(v);
  };

  for (const r of allManifests) {
    if (r.kind === "Telo.Import") {
      const m = (r.metadata as { resolvedModuleName?: unknown } | undefined)?.resolvedModuleName;
      if (typeof m === "string") loadedModules.add(m);
      continue;
    }
    const meta = r.metadata as { name?: unknown; module?: unknown; forwardedExport?: unknown };
    if (typeof meta?.name !== "string" || REF_VALIDATION_SKIP_KINDS.has(r.kind)) continue;
    if (meta.forwardedExport === true) {
      if (typeof meta.module === "string") loadedModules.add(meta.module);
      continue;
    }
    localNames.add(meta.name);
    collectNestedNames(r);
  }

  const validateInvoke = (
    value: unknown,
    resource: { kind: string; name: string },
    filePath: string | undefined,
    path: string,
  ): void => {
    if (isRefSentinel(value)) {
      // An unresolved `!ref` is a miss: a real instance would have resolved to
      // `{kind, name}` in Phase 2.5.
      const refName = value.source;
      const dot = refName.indexOf(".");
      const aliasPrefix = dot > 0 ? refName.slice(0, dot) : undefined;

      if (aliasPrefix && aliasPrefix !== "Self" && aliases.hasAlias(aliasPrefix)) {
        const module = aliases.moduleForAlias(aliasPrefix);
        // Partial single-file analysis (import not loaded) — skip to avoid a false miss.
        if (module && !loadedModules.has(module)) return;
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "UNRESOLVED_REFERENCE",
          source: SOURCE,
          message: `${resource.kind}/${resource.name}: step invoke at '${path}' → '${refName}' is not an exported instance of module '${module ?? aliasPrefix}' (reference a declared instance, not a kind)`,
          data: { resource, filePath, path },
        });
        return;
      }

      const localName = aliasPrefix === "Self" ? refName.slice(dot + 1) : refName;
      if (localNames.has(localName)) return;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "UNRESOLVED_REFERENCE",
        source: SOURCE,
        message: `${resource.kind}/${resource.name}: step invoke at '${path}' → resource '${localName}' not found`,
        data: { resource, filePath, path },
      });
      return;
    }

    // Resolved `{kind, name}` (or an inline `{kind, …}` definition) — the
    // instance exists. Mirror the kernel's ERR_RESOURCE_NOT_INVOKABLE, which
    // fires when the instance has neither an `invoke` nor a `run` method
    // (evaluation-context.ts). That is a per-instance property, not a pure
    // capability, so only capabilities that STRUCTURALLY expose no such method
    // are rejected statically — Service is intentionally excluded, since some
    // services are invocable (e.g. a function handler dispatched directly).
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const kind = (value as Record<string, unknown>).kind;
    if (typeof kind !== "string") return;
    const capability = defs.resolve(aliases.resolveKind(kind) ?? kind)?.capability;
    if (typeof capability === "string" && NON_INVOKABLE_CAPABILITIES.has(capability)) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "REFERENCE_KIND_MISMATCH",
        source: SOURCE,
        message: `${resource.kind}/${resource.name}: step invoke at '${path}' → '${kind}' is a ${capability} and cannot be invoked in a step — it has no invoke or run method (runtime ERR_RESOURCE_NOT_INVOKABLE)`,
        data: { resource, filePath, path },
      });
    }
  };

  for (const m of allManifests) {
    const meta = m.metadata as { name?: unknown; source?: unknown; forwardedExport?: unknown };
    if (
      typeof meta?.name !== "string" ||
      REF_VALIDATION_SKIP_KINDS.has(m.kind) ||
      meta.forwardedExport === true
    )
      continue;
    const def = defs.resolve(aliases.resolveKind(m.kind) ?? m.kind);
    const defSchema = def?.schema as Record<string, any> | undefined;
    if (!defSchema?.properties) continue;
    const resource = { kind: m.kind, name: meta.name };
    const filePath = typeof meta.source === "string" ? meta.source : undefined;

    for (const [fieldName, fieldSchema] of Object.entries(
      defSchema.properties as Record<string, any>,
    )) {
      const stepCtx = fieldSchema["x-telo-step-context"] as Record<string, string> | undefined;
      const invokeField = stepCtx?.invoke;
      if (!invokeField) continue;
      const steps = m[fieldName];
      if (!Array.isArray(steps)) continue;
      const stepItemSchema = resolveLocalRef(
        fieldSchema.items as Record<string, any> | undefined,
        defSchema,
      );

      walkStepArray(steps, stepItemSchema, defSchema, fieldName, (s, stepPath) => {
        const invoke = s[invokeField];
        if (invoke === undefined || invoke === null) return;
        validateInvoke(invoke, resource, filePath, `${stepPath}.${invokeField}`);
      });
    }
  }

  return diagnostics;
}

/**
 * Collect every field annotated with `x-telo-error-context` anywhere in a
 * definition schema (resolving local `$ref`s into `$defs`, cycle-safe), mapping
 * the annotated field name to its declared error-shape schema. The field name
 * is matched against CEL paths so the context applies at any nesting depth under
 * that field — e.g. `error` inside a `catch:` nested inside another `try:`. No
 * specific field name (or `Run.Sequence`) is hardcoded; any composer that tags
 * its error-bearing branch fields opts in the same way.
 */
/**
 * True when a `walkCelExpressions` path (`with[0].handler.inputs.x`) crosses an
 * inline nested resource — an `{ kind: … }` object below the host root — before
 * reaching the leaf. Such CEL belongs to the nested resource's kind (validated
 * when that resource is analyzed), not the host's schema, so the
 * non-eval-field check must not attribute it to the host.
 */
function pathCrossesNestedResource(root: unknown, path: string): boolean {
  const segments = path.match(/[^.[\]]+/g) ?? [];
  let node: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    node = Array.isArray(node)
      ? node[Number(segments[i])]
      : (node as Record<string, unknown> | undefined)?.[segments[i]!];
    if (
      node !== null &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      typeof (node as { kind?: unknown }).kind === "string"
    ) {
      return true;
    }
  }
  return false;
}

function collectErrorContextScopes(
  defSchema: Record<string, any> | undefined,
): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  if (!defSchema || typeof defSchema !== "object") return out;
  const seen = new Set<Record<string, any>>();

  const walk = (schema: Record<string, any> | undefined): void => {
    if (!schema || typeof schema !== "object" || seen.has(schema)) return;
    seen.add(schema);

    const props = schema.properties as Record<string, any> | undefined;
    if (props) {
      for (const [fieldName, fieldSchema] of Object.entries(props)) {
        if (fieldSchema && typeof fieldSchema === "object") {
          const errCtx = (fieldSchema as Record<string, any>)["x-telo-error-context"];
          if (errCtx && typeof errCtx === "object" && !out.has(fieldName)) {
            out.set(fieldName, errCtx as Record<string, any>);
          }
        }
        walk(resolveLocalRef(fieldSchema as Record<string, any>, defSchema));
      }
    }
    if (schema.items) walk(resolveLocalRef(schema.items as Record<string, any>, defSchema));
    for (const key of ["oneOf", "anyOf", "allOf"] as const) {
      const arr = schema[key];
      if (Array.isArray(arr)) for (const sub of arr) walk(resolveLocalRef(sub, defSchema));
    }
    if (schema.$defs && typeof schema.$defs === "object") {
      for (const sub of Object.values(schema.$defs as Record<string, any>)) {
        walk(sub as Record<string, any>);
      }
    }
  };

  walk(defSchema);
  return out;
}

/**
 * Return the error-context schema for a CEL `path` when the path lies within
 * (any depth under) one of the error-bearing fields, else undefined. A path is
 * "within" field `f` when it contains a segment `f[<index>]`. When multiple
 * error-bearing fields match (e.g. a `finally` nested inside a `catch`), the
 * deepest — the one whose segment appears latest in the path — wins, so the
 * innermost branch's schema governs.
 */
function errorContextForPath(
  path: string,
  scopes: Map<string, Record<string, any>>,
): Record<string, any> | undefined {
  let best: { index: number; schema: Record<string, any> } | undefined;
  for (const [fieldName, schema] of scopes) {
    const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of path.matchAll(new RegExp(`(^|\\.)${escaped}\\[\\d+\\]`, "g"))) {
      if (best === undefined || match.index > best.index) {
        best = { index: match.index, schema };
      }
    }
  }
  return best?.schema;
}

const CEL_PURE_RE = /^\s*\$\{\{[^}]*\}\}\s*$/;
const CEL_EXPR_RE = /\$\{\{\s*([^}]+?)\s*\}\}/;

/** Recursively walk `data`+`schema` together, type-checking every pure CEL template
 *  string via `env.check()`. Returns `SchemaIssue[]` for any type mismatches found. */
function collectCelTypeIssues(
  data: unknown,
  schema: Record<string, any>,
  path: string,
  definition: { schema?: Record<string, any> },
  manifest: ResourceManifest,
  baseTypedEnv: Environment,
  rootEnv: Environment,
  rootModuleManifest?: ResourceManifest,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  // A pure CEL value type-checks the same regardless of surface form: a
  // `${{ … }}` string and a `!cel`-tagged sentinel must behave identically.
  let celExpr: string | undefined;
  if (isTaggedSentinel(data)) {
    // Non-CEL engines (e.g. `!literal`) are analyzed by their own engine pass.
    if (data.engine !== "cel") return issues;
    celExpr = data.source;
  } else if (typeof data === "string" && CEL_PURE_RE.test(data)) {
    celExpr = data.match(CEL_EXPR_RE)?.[1]?.trim();
  }

  if (celExpr !== undefined) {
    {
      const expr = celExpr;

      // Merge x-telo-context variables for this path if applicable
      let typedEnv = baseTypedEnv;
      if (definition.schema) {
        for (const ctx of extractContextsFromSchema(definition.schema)) {
          if (!pathMatchesScope(path, ctx.scope)) continue;
          typedEnv = buildTypedCelEnvironment(rootEnv, manifest, ctx.schema, rootModuleManifest);
          break;
        }
      }

      let checkResult: ReturnType<typeof typedEnv.check> | undefined;
      try {
        checkResult = typedEnv.check(expr);
      } catch {
        /* degrade gracefully */
      }

      if (checkResult?.valid === false && checkResult.error) {
        // env.check() rejected the expression itself — e.g. wrong method, wrong
        // argument types, wrong operator overload. Surface the first line of the
        // error message; the tail is a source-code caret diagram we don't need.
        const message = String((checkResult.error as { message?: string }).message ?? checkResult.error)
          .split("\n")[0]
          .trim();
        issues.push({ message: `CEL type error: ${message}`, path });
      } else if (checkResult?.valid && checkResult.type && schema) {
        const celType = checkResult.type.split("<")[0]!;
        if (!celTypeSatisfiesJsonSchema(celType, schema)) {
          const expected = schema["x-telo-type"] ?? schema.type ?? "unknown";
          issues.push({
            message: `CEL returns '${checkResult.type}' but field expects '${expected}'`,
            path,
          });
        }
      }
    }
    return issues;
  }

  if (Array.isArray(data)) {
    const itemSchema = (schema.items ?? {}) as Record<string, any>;
    for (let i = 0; i < data.length; i++) {
      issues.push(
        ...collectCelTypeIssues(
          data[i],
          itemSchema,
          `${path}[${i}]`,
          definition,
          manifest,
          baseTypedEnv,
          rootEnv,
          rootModuleManifest,
        ),
      );
    }
  } else if (data !== null && typeof data === "object") {
    const props = (schema.properties ?? {}) as Record<string, any>;
    const mapValueSchema =
      schema.additionalProperties && typeof schema.additionalProperties === "object"
        ? (schema.additionalProperties as Record<string, any>)
        : {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      issues.push(
        ...collectCelTypeIssues(
          v,
          (props[k] ?? mapValueSchema) as Record<string, any>,
          path ? `${path}.${k}` : k,
          definition,
          manifest,
          baseTypedEnv,
          rootEnv,
          rootModuleManifest,
        ),
      );
    }
  }

  return issues;
}

export interface StaticAnalyzerOptions {
  celHandlers?: CelHandlers;
}

export class StaticAnalyzer {
  private readonly celEnv: Environment;

  constructor(options: StaticAnalyzerOptions = {}) {
    this.celEnv = buildCelEnvironment(options.celHandlers);
  }

  /**
   * Run static analysis over a flattened manifest list.
   *
   * **Contract**: every non-system manifest (anything outside `Telo.Definition`,
   * `Telo.Abstract`) must carry `metadata.source` (non-empty string) and
   * `metadata.sourceLine` (number). The dedup that backs
   * `DUPLICATE_RESOURCE_NAME` reads those fields to tell a pipeline echo
   * apart from a genuine collision, and downstream diagnostic positioning
   * depends on them too. Real callers stamp positions already (the `Loader`,
   * `flattenForAnalyzer`, the telo-editor's `emitDocsFor`, the VSCode
   * extension). Programmatic callers — tests, ad-hoc scripts — should pass
   * their inputs through `withSyntheticPositions(...)` before calling
   * `analyze()`. A missing position throws a clear error rather than
   * silently producing wrong diagnostics.
   */
  analyze(
    manifests: ResourceManifest[],
    options?: AnalysisOptions,
    registry?: AnalysisRegistry,
  ): AnalysisDiagnostic[] {
    assertManifestPositions(manifests);
    const diagnostics: AnalysisDiagnostic[] = [];

    // Use pre-seeded registries from the provided AnalysisRegistry, or create fresh ones.
    // New aliases/definitions found in the manifests are accumulated into the provided instance
    // so state builds up across successive calls (e.g. incremental editor validation).
    const ctx = registry?._context();
    const aliases = ctx?.aliases ?? new AliasResolver();
    const defs = ctx?.definitions ?? new DefinitionRegistry();

    // Register module identities and aliases.
    // The root module doc (Telo.Application or Telo.Library) provides its own
    // identity; imported modules surface their identity via resolvedModuleName/
    // resolvedNamespace stamped onto the Telo.Import by the loader.
    //
    // Two alias scopes are tracked:
    //  - `aliases` — the consumer's aliases, populated from Telo.Imports declared in
    //    the entry manifest (its own module).
    //  - `aliasesByModule` — per-imported-library aliases, populated from Telo.Imports
    //    forwarded by the loader from inside imported libraries. A library may use
    //    different alias names than the consumer for the same dependency; resolving
    //    a forwarded def's `extends` / `capability` against the consumer's scope
    //    would either fail or pick the wrong target. Each forwarded def is normalized
    //    in its own library's scope.
    const rootModules = new Set<string>();
    for (const m of manifests) {
      if (isModuleKind(m.kind) && m.metadata?.name) {
        rootModules.add(m.metadata.name as string);
      }
    }
    const aliasesByModule = ctx?.aliasesByModule ?? new Map<string, AliasResolver>();
    // Per-module-scope seen aliases for DUPLICATE_IMPORT_ALIAS. Authored
    // Telo.Import docs and synthetic-from-inline-`imports:` share one alias
    // namespace per module, so a repeat — across either form — is an error
    // rather than the silent last-writer-wins the resolver would otherwise do.
    const seenAliasByScope = new Map<string, Set<string>>();
    for (const m of manifests) {
      if (isModuleKind(m.kind)) {
        const namespace = ((m.metadata as any).namespace as string | undefined) ?? null;
        const moduleName = m.metadata.name as string;
        if (moduleName) defs.registerModuleIdentity(namespace, moduleName);
        // Auto-register `Self` as an alias for this library's own module name.
        // Lets same-library `extends:` work (e.g. `extends: Self.Encoder` for a
        // concrete kind whose abstract lives in the same Telo.Library) without
        // requiring a self-import (which would loop the loader). Resolves
        // through the same alias machinery as user-declared Telo.Imports —
        // honours the library's `exports.kinds` list, no special cases.
        if (moduleName) {
          // `Self` resolves the library's own kinds UNGATED — a library may reference
          // its own kinds regardless of `exports.kinds`, which gates importers, not
          // internal use. This is what lets a library declare an instance of a kind it
          // does not export (e.g. console's `writeLine`) to enforce a singleton.
          if (rootModules.has(moduleName)) {
            aliases.registerImport("Self", moduleName, []);
          } else {
            let libResolver = aliasesByModule.get(moduleName);
            if (!libResolver) {
              libResolver = new AliasResolver();
              aliasesByModule.set(moduleName, libResolver);
            }
            libResolver.registerImport("Self", moduleName, []);
          }
        }
      }
      if (m.kind === "Telo.Import") {
        const alias = m.metadata.name as string;
        const source = (m as any).source as string | undefined;
        const exportedKinds: string[] = (m as any).exports?.kinds ?? [];
        const resolvedModuleName = (m.metadata as any).resolvedModuleName as string | undefined;
        const resolvedNamespace = (m.metadata as any).resolvedNamespace as
          | string
          | null
          | undefined;
        const ownModule = (m.metadata as { module?: string } | undefined)?.module;
        if (alias) {
          const scopeKey = ownModule ?? "";
          let seen = seenAliasByScope.get(scopeKey);
          if (!seen) {
            seen = new Set<string>();
            seenAliasByScope.set(scopeKey, seen);
          }
          if (seen.has(alias)) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "DUPLICATE_IMPORT_ALIAS",
              source: SOURCE,
              message:
                `Duplicate import alias '${alias}'. An alias may be declared once per module — ` +
                `across both inline 'imports:' entries and 'Telo.Import' documents. ` +
                `Rename or remove the duplicate.`,
              data: {
                resource: { kind: "Telo.Import", name: alias },
                filePath: (m.metadata as { source?: string } | undefined)?.source,
                path: "metadata.name",
              },
            });
            // Keep the first alias→target mapping intact; don't re-register the
            // duplicate (last-writer-wins would shadow the original and cascade
            // misleading follow-on diagnostics).
            continue;
          }
          seen.add(alias);
        }
        if (alias && source) {
          const targetModule =
            resolvedModuleName ?? source.split("/").filter(Boolean).pop() ?? source;
          // Module identity is registered globally so x-telo-ref resolution sees
          // transitively-imported modules regardless of which scope brought them in.
          if (resolvedModuleName) {
            defs.registerModuleIdentity(resolvedNamespace ?? null, resolvedModuleName);
          }
          // `metadata.reExportedKinds` (stamped by flattenForAnalyzer / the editor projection)
          // maps an exported suffix to the true owning module's canonical kind for kinds this
          // import transitively re-exports (`exports.kinds: [Alias.Kind]`).
          const reExportedKinds = ((m.metadata as any)?.reExportedKinds ?? {}) as Record<
            string,
            string
          >;
          // Alias registration is scoped: consumer imports vs. imported-library imports.
          const resolver =
            !ownModule || rootModules.has(ownModule)
              ? aliases
              : (aliasesByModule.get(ownModule) ??
                aliasesByModule.set(ownModule, new AliasResolver()).get(ownModule)!);
          resolver.registerImport(alias, targetModule, exportedKinds);
          for (const [suffix, canonical] of Object.entries(reExportedKinds)) {
            resolver.registerKindReExport(alias, suffix, canonical);
          }
        }
      }
    }

    // Seed `Self` for every module that contributes definitions but whose own
    // Telo.Library doc isn't in this manifest set. `flattenForAnalyzer` forwards an
    // imported library's definitions/abstracts/imports but NOT its module doc, so the
    // module-doc loop above can't register `Self` for imported modules. Without this, a
    // definition's `extends: Self.X` (a kind defined in the same library as the abstract)
    // can't resolve and its `extendedBy` edge mis-keys under the literal "Self.X" — which
    // stays invisible until another module also implements that abstract and flips the
    // reference check from lenient to strict. `Self` always maps a module to its own name.
    for (const m of manifests) {
      if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
      const ownModule = (m.metadata as { module?: string } | undefined)?.module;
      if (!ownModule || rootModules.has(ownModule)) continue;
      let libResolver = aliasesByModule.get(ownModule);
      if (!libResolver) {
        libResolver = new AliasResolver();
        aliasesByModule.set(ownModule, libResolver);
      }
      if (!libResolver.hasAlias("Self")) {
        libResolver.registerImport("Self", ownModule, []);
      }
    }

    // Register definitions from Telo.Definition AND Telo.Abstract resources.
    // Abstracts declare contracts that implementations target via `extends` (canonical)
    // or `capability: <AbstractKind>` (legacy). Until they're registered, validateReferences
    // can't resolve x-telo-ref entries pointing at library-declared abstracts — so abstracts
    // must go through register() too, not just the kernel builtins in the constructor.
    //
    // Normalize alias-prefixed `capability` and `extends` to canonical form using the
    // declaring scope's resolver, so `extendedBy` is keyed by canonical kind regardless
    // of alias choices. `capability` covers the legacy implements-this-abstract overload;
    // `extends` is the canonical first-class form.
    for (const m of manifests) {
      if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
      const def = m as unknown as ResourceDefinition;
      const ownModule = (def.metadata as { module?: string } | undefined)?.module;
      const scopeResolver =
        ownModule && !rootModules.has(ownModule)
          ? (aliasesByModule.get(ownModule) ?? new AliasResolver())
          : aliases;
      const resolvedCapability = def.capability
        ? (scopeResolver.resolveKind(def.capability) ?? def.capability)
        : def.capability;
      const resolvedExtends = def.extends
        ? (scopeResolver.resolveKind(def.extends) ?? def.extends)
        : def.extends;
      const needsPatch =
        resolvedCapability !== def.capability || resolvedExtends !== def.extends;
      const normalized = needsPatch
        ? { ...def, capability: resolvedCapability, extends: resolvedExtends }
        : def;
      defs.register(normalized);
    }

    // Reference-form validation — enforce `!ref` as the only reference shape.
    // Runs on the RAW manifests, BEFORE inline extraction and sentinel
    // resolution, while an author-written `{kind, name}` is still
    // distinguishable from the resolver's own substitution (after Phase 2/2.5
    // they are the same object).
    if (!options?.skipValidation) {
      diagnostics.push(...validateReferenceForms(manifests, defs, aliases, aliasesByModule));
    }

    // Phase 2: extract inline resources from x-telo-ref slots into first-class manifests
    const allManifests = normalizeInlineResources(manifests, defs, aliases, aliasesByModule);

    // Phase 2.5: resolve `!ref <name>` sentinels at every ref slot to canonical
    // {kind, name} objects so downstream phases (validation, dependency graph,
    // kernel controllers) see a uniform shape. Runs after normalize so both
    // original and inline-extracted manifests have their sentinels resolved.
    resolveRefSentinels(allManifests, aliases, aliasesByModule);

    // Phase 2.6: register each named `Telo.Type` resource's schema under its
    // canonical module-scoped id (`telo://<module>/<name>`), validate
    // `telo://Self|Alias/Type` schema refs resolve to one, then rewrite those
    // refs to the canonical id so AJV resolves them at compile time. Register
    // and validate BEFORE the rewrite, while the authored authority is intact.
    for (const m of allManifests) {
      const ownModule = (m.metadata as { module?: string } | undefined)?.module;
      if (!ownModule || !m.metadata?.name || typeof m.schema !== "object" || m.schema === null) {
        continue;
      }
      const scopeResolver =
        rootModules.has(ownModule) ? aliases : (aliasesByModule.get(ownModule) ?? new AliasResolver());
      const canonicalKind = scopeResolver.resolveKind(m.kind as string) ?? (m.kind as string);
      if (defs.resolve(canonicalKind)?.capability !== "Telo.Type") continue;
      defs.registerNamedTypeSchema(
        canonicalTypeSchemaId(ownModule, m.metadata.name as string),
        m.schema as Record<string, any>,
      );
    }
    if (!options?.skipValidation) {
      diagnostics.push(
        ...validateSchemaTypeRefs(allManifests, defs, aliases, aliasesByModule, rootModules),
      );
    }
    resolveSchemaTypeRefs(allManifests, aliases, aliasesByModule);

    // Trusted-input fast path: when the caller has already attested that
    // this exact manifest set passes analysis (e.g. via the kernel's
    // hash-stamped `.validated.json` cache), skip the validation walk.
    // Registration of identities / aliases / definitions and inline-resource
    // normalisation have already run above; that's all downstream
    // consumers (prepare, init loop) require.
    if (options?.skipValidation) {
      return diagnostics;
    }

    // Build a name→manifest map for looking up referenced resources
    const byName = new Map<string, ResourceManifest>();
    for (const m of allManifests) {
      if (m.metadata?.name) {
        byName.set(m.metadata.name as string, m);
      }
    }

    // Fail loud on definition schemas AJV cannot compile. `validateAgainstSchema`
    // and `validateWithRefs` swallow compile failures (returning no issues),
    // which would silently skip schema validation for every resource of that
    // kind — surface the broken schema once, anchored on the definition itself.
    for (const m of allManifests) {
      if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
      const schema = (m as Record<string, any>).schema;
      if (!schema || typeof schema !== "object") continue;
      const name = m.metadata?.name as string | undefined;
      if (!name) continue;
      const compileError = defs.schemaCompileError(schema as Record<string, any>);
      if (compileError) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "SCHEMA_COMPILE_ERROR",
          source: SOURCE,
          message: `${m.kind}/${name}: definition schema failed to compile: ${compileError}`,
          data: {
            resource: { kind: m.kind, name },
            filePath: (m.metadata as { source?: string } | undefined)?.source,
            path: "schema",
          },
        });
      }
    }

    // Library env: rejection — `env:` on a Library `variables` / `secrets`
    // entry is forbidden. The Library entry schema is otherwise open so that
    // any JSON Schema property schema is valid; this targeted check produces
    // a clear diagnostic instead of a generic "additional property" error.
    for (const m of allManifests) {
      if (m.kind !== "Telo.Library") continue;
      const filePath = (m.metadata as { source?: string } | undefined)?.source;
      const moduleName = m.metadata?.name as string | undefined;
      const resource = moduleName ? { kind: m.kind, name: moduleName } : undefined;
      for (const block of ["variables", "secrets"] as const) {
        const entries = (m as Record<string, any>)[block];
        if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
        for (const [entryName, entry] of Object.entries(entries)) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          if ("env" in (entry as Record<string, unknown>)) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "LIBRARY_ENV_KEY_REJECTED",
              source: SOURCE,
              message:
                `Telo.Library ${block}/${entryName}: 'env:' is only permitted on Telo.Application entries. ` +
                `Libraries must receive values from importers via the parent manifest's variables / secrets block.`,
              data: { resource, filePath, path: `${block}.${entryName}.env` },
            });
          }
        }
      }
      // `exports.resources` entries are plain names: `Db` (local) or `Alias.Name` (re-export),
      // mirroring `exports.kinds`. The `!ref` tag is not accepted here — a `!ref` parses to a
      // sentinel object that the schema's CEL/ref exemption would silently pass, so reject any
      // non-string entry with an actionable message instead.
      const exportsResources = (m as Record<string, any>).exports?.resources;
      if (Array.isArray(exportsResources)) {
        for (let i = 0; i < exportsResources.length; i++) {
          if (typeof exportsResources[i] === "string") continue;
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "INVALID_EXPORT",
            source: SOURCE,
            message:
              `Telo.Library exports.resources[${i}]: write the exported name as a plain string — ` +
              `'Name' to export a local instance, or 'Alias.Name' to re-export an imported one. ` +
              `The '!ref' tag is not allowed in exports.resources.`,
            data: { resource, filePath, path: `exports.resources.${i}` },
          });
        }
      }
    }

    // Build typed kernel globals schema so x-telo-context chain validation
    // recognises variables, secrets, resources, env automatically
    const kernelGlobals = buildKernelGlobalsSchema(allManifests);

    // The module doc (Application/Library) carries the Application-only `ports`
    // namespace; threaded into per-resource CEL typing so `${{ ports.X }}`
    // resolves its nominal brand cross-doc.
    const moduleManifest =
      allManifests.find((mm) => mm.kind === "Telo.Application") ??
      allManifests.find((mm) => mm.kind === "Telo.Library");

    // Validate each non-definition, non-system resource
    for (const m of allManifests) {
      const filePath = (m.metadata as { source?: string } | undefined)?.source;
      if (!m.kind || !m.metadata?.name) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "MISSING_KIND_OR_NAME",
          source: SOURCE,
          message: "Resource is missing required 'kind' or 'metadata.name' field.",
          data: { filePath, path: !m.kind ? "kind" : "metadata.name" },
        });
        continue;
      }
      // Abstracts carry only inputType / outputType schema fields and no template
      // body — nothing for the per-resource walk to validate. Definitions are now
      // walked: their template bodies (`resources` / `invoke` / `run` / `provide`)
      // contain CEL that must be checked against `self` / `inputs` / `result`.
      if (m.kind === "Telo.Abstract") {
        continue;
      }

      // Forwarded exports (flagged by flattenForAnalyzer) are an imported library's exported
      // instances, already validated in their own module's standalone analysis; their
      // `kind`/CEL are authored in that module's scope (e.g. `Self.X` → that module, not the
      // consumer). Re-validating against the consumer's scope yields false UNDEFINED_KIND /
      // scope-mismatch errors, so skip — they participate here only as resolution targets.
      if ((m.metadata as { forwardedExport?: boolean } | undefined)?.forwardedExport === true) {
        continue;
      }

      const resource = { kind: m.kind, name: m.metadata?.name as string };

      // Resolve kind through alias if needed; direct lookup takes priority so that
      // aliases whose name matches the module name (the common case) work without
      // path-derived name mangling. A resource that originated in an imported library
      // (its `metadata.module` names a non-root module — e.g. an inline route handler
      // extracted from an imported Http.Api) must resolve its kind alias against THAT
      // library's import map, not the consumer's; an anonymous child inherits the
      // lexical scope of the document that declares it. Mirrors the nested-inline and
      // reference-resolution paths: own-module scope first, root/consumer aliases last.
      const ownModule = (m.metadata as { module?: string } | undefined)?.module;
      const scopeResolver = scopeResolverForModule(ownModule, rootModules, aliasesByModule);
      const resolvedKind = scopeResolver?.resolveKind(m.kind) ?? aliases.resolveKind(m.kind);
      const definition =
        defs.resolve(m.kind) ?? (resolvedKind ? defs.resolve(resolvedKind) : undefined);
      if (!definition) {
        const suggestedKind = computeSuggestKind(m.kind, aliases, defs);
        const hint = suggestedKind ? ` Did you mean '${suggestedKind}'?` : "";
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "UNDEFINED_KIND",
          source: SOURCE,
          message: `No Telo.Definition found for kind '${m.kind}'.${hint}`,
          data: { resource, filePath, path: "kind", suggestedKind },
        });
        continue;
      }

      // Validate resource config against the definition's AUTHOR-FACING schema —
      // inheritance-resolved: with `base:` the child's own schema (parent config
      // is internal), else `merge(parent, own)` so a `base:`-less `extends` child
      // is validated against the inherited fields it may set. For a definition
      // that neither extends nor uses `base:` this is exactly its own schema.
      // `kind` and `metadata` are implicit on every resource — inject them so module
      // authors don't have to repeat them when using additionalProperties: false.
      const authorSchema = effectiveAuthorSchema(definition, (k) =>
        defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k),
      );
      if (authorSchema && Object.keys(authorSchema).length > 0) {
        const schema =
          authorSchema.additionalProperties === false
            ? {
                ...authorSchema,
                properties: {
                  kind: { type: "string" },
                  metadata: { type: "object" },
                  ...authorSchema.properties,
                },
              }
            : authorSchema;
        // Phase 1: CEL type checking — walk data+schema together, check env.check() return types.
        // A Telo.Import's variables/secrets are a config-only contract evaluated against the
        // IMPORTING module's scope, so type them from the owning module doc (matched by
        // `metadata.module`) and drop `resources`/`env` so referencing them is an error. A
        // library's own internal import is validated against that library in the library's
        // standalone analysis; in this flattened app pass the library doc is absent, so the
        // importer is undefined here and variables/secrets fall back to a permissive `map`
        // (no false positives) while resources/env stay rejected.
        const importerModule =
          m.kind === "Telo.Import"
            ? allManifests.find(
                (mm) =>
                  (mm.kind === "Telo.Application" || mm.kind === "Telo.Library") &&
                  (mm.metadata as { name?: string } | undefined)?.name ===
                    (m.metadata as { module?: string } | undefined)?.module,
              )
            : undefined;
        const baseTypedEnv =
          m.kind === "Telo.Import"
            ? buildImportInputCelEnvironment(this.celEnv, importerModule)
            : buildTypedCelEnvironment(this.celEnv, m, undefined, moduleManifest);
        const celIssues = collectCelTypeIssues(
          m,
          schema,
          "",
          definition,
          m,
          baseTypedEnv,
          this.celEnv,
          moduleManifest,
        );
        // Phase 2+3: AJV on substituted data — CEL fields replaced with typed placeholders
        const ajvIssues = validateAgainstSchema(substituteCelFields(m, schema), schema);
        const issues = [...celIssues, ...ajvIssues];
        for (const issue of issues) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCHEMA_VIOLATION",
            source: SOURCE,
            message: `${m.kind}/${resource.name}: ${issue.message}`,
            data: { resource, filePath, path: issue.path },
          });
        }
      }

      // Validate inline resources nested inside this resource's body (e.g. a
      // Run.Sequence step's `invoke: { kind, ...config }`). These sit at
      // x-telo-ref slots reached only through local `$ref`s, which the
      // reference field map intentionally does not follow, so they escape both
      // inline-extraction and the per-resource schema check above.
      if (definition.schema) {
        // Resolve inline kinds in the parent resource's scope: direct kind
        // first, then the parent module's own aliases (for resources declared
        // inside an imported module), then the root aliases. Mirrors how the
        // analyzer resolves kinds elsewhere so module-scoped aliases don't
        // produce false UNDEFINED_KIND diagnostics. `scopeResolver` is the
        // owning module's resolver computed above.
        diagnostics.push(
          ...validateNestedInlineResources(
            m,
            definition.schema as Record<string, any>,
            (kind: string) => {
              const direct = defs.resolve(kind);
              if (direct) return direct;
              const viaScope = scopeResolver?.resolveKind(kind);
              if (viaScope) {
                const scoped = defs.resolve(viaScope);
                if (scoped) return scoped;
              }
              const viaRoot = aliases.resolveKind(kind);
              return viaRoot ? defs.resolve(viaRoot) : undefined;
            },
          ),
        );
      }

      // (Invocation context compatibility check is handled via x-telo-context in the CEL pass below)
    }

    // Template-body structural validations: check that template entry-points produce
    // values matching the contract of their dispatch target and (for `provide:`)
    // the abstract this definition `extends`. CEL fields inside the templated
    // values are replaced with type-appropriate placeholders before AJV runs —
    // same pattern as the per-resource schema validation above.
    for (const m of allManifests) {
      if (m.kind !== "Telo.Definition") continue;
      const filePath = (m.metadata as { source?: string } | undefined)?.source;
      const name = (m.metadata as any)?.name as string | undefined;
      if (!name) continue;
      const resource = { kind: m.kind, name };
      const md = m as Record<string, any>;

      const emitTargetMismatch = (
        targetKind: string,
        valueSchema: Record<string, any>,
        value: unknown,
        path: string,
      ) => {
        const substituted = substituteCelFields(value, valueSchema);
        const issues = validateAgainstSchema(substituted, valueSchema);
        for (const issue of issues) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "TEMPLATE_TARGET_MISMATCH",
            source: SOURCE,
            message: `${m.kind}/${name}: ${path} does not satisfy ${targetKind}'s contract: ${issue.message}`,
            data: { resource, filePath, path: issue.path ? `${path}.${issue.path}` : path },
          });
        }
      };

      // Resolve the dispatch target's kind, if statically known. Object-form
      // `invoke: { kind, name }` and `provide: { kind, name }` carry it; the
      // string-form `invoke: "name"` does not (the matching resource entry would
      // need to be located by expanded name — out of scope here).
      const invoke = md.invoke;
      const provide = md.provide;
      let dispatchKind: string | undefined;
      if (invoke && typeof invoke === "object" && !Array.isArray(invoke) && typeof invoke.kind === "string") {
        dispatchKind = invoke.kind;
      } else if (
        provide &&
        typeof provide === "object" &&
        !Array.isArray(provide) &&
        typeof provide.kind === "string"
      ) {
        dispatchKind = provide.kind;
      }

      // Top-level `inputs:` (sibling of `invoke:` / `provide:`) carries the
      // values passed to the dispatch target's invoke(). Validate against the
      // target's declared `inputType` when both sides have one.
      if (dispatchKind && md.inputs && typeof md.inputs === "object") {
        const targetSchema = lookupDefinitionTypeField(
          dispatchKind,
          "inputType",
          defs,
          aliases,
          allManifests as Record<string, any>[],
        );
        if (targetSchema) {
          emitTargetMismatch(dispatchKind, targetSchema, md.inputs, "inputs");
        }
      }

      // Top-level `result:` is a post-call mapping that must satisfy the abstract
      // this definition `extends` (`outputType`). It's a sibling of whichever
      // dispatch entry-point declared a kind-typed target (`provide:` or
      // `invoke:`). The target's outputType lives on the dispatcher's `kind`
      // and is what `result` is typed against *inside* CEL — separate role.
      const hasDispatchObject =
        (provide && typeof provide === "object" && !Array.isArray(provide)) ||
        (invoke && typeof invoke === "object" && !Array.isArray(invoke));
      if (hasDispatchObject && md.result && typeof md.result === "object") {
        const extendsValue = md.extends as string | undefined;
        if (typeof extendsValue === "string" && extendsValue.length > 0) {
          const abstractSchema = lookupDefinitionTypeField(
            extendsValue,
            "outputType",
            defs,
            aliases,
            allManifests as Record<string, any>[],
          );
          if (abstractSchema) {
            emitTargetMismatch(extendsValue, abstractSchema, md.result, "result");
          }
        }
      }
    }

    // Validate CEL syntax and context variable access in all manifests. The
    // walker discovers every compiled CEL node by scanning the value tree and
    // hands back the `x-telo-context` schema matched at the enclosing path; the
    // per-path resolution (step context, kernel-globals merge, x-telo-context-*
    // annotation resolution) stays here because it depends on analyzer-internal
    // state (definitions, aliases, the typed CEL env).
    // Per-resource state computed at enter and read by that resource's CEL
    // sites. The manifest / resource / filePath come straight off each CelSite's
    // `source` (no need to capture them); only the derived step / invocation
    // context — which require analyzer state to build — are stashed here.
    let celStepContextSchema: Record<string, any> | undefined;
    let celInvocationContext: Record<string, any> | undefined;
    let celErrorScopes: Map<string, Record<string, any>> = new Map();
    // Region coverage for the "CEL in a non-eval field" check: the union of
    // `x-telo-eval` paths (own + capability) and `x-telo-context` /
    // `x-telo-step-context` / `x-telo-error-context` scopes. A `!cel` outside
    // every region is read as a literal — the runtime never evaluates it.
    let celEvalPaths: string[] = [];
    let celRegionScopes: string[] = [];
    let celRuleApplies = false;

    visitManifest(
      allManifests,
      defs,
      {
        onResourceEnter: (e) => {
          const m = e.source;
          celInvocationContext = (m.metadata as any)?.xTeloInvocationContext as
            | Record<string, any>
            | undefined;
          celStepContextSchema = e.definition?.schema
            ? buildStepContextSchema(
                m as Record<string, any>,
                e.definition.schema as Record<string, any>,
                allManifests as Record<string, any>[],
                defs,
                aliases,
              )
            : undefined;
          celErrorScopes = collectErrorContextScopes(
            e.definition?.schema as Record<string, any> | undefined,
          );

          // The non-eval-field check only applies to runtime resource instances:
          // structural / templating kinds (capability `Telo.Template`, or no
          // definition) carry CEL the kernel evaluates by other rules.
          const capability = e.definition?.capability;
          celRuleApplies =
            !!e.definition?.schema && capability !== undefined && capability !== "Telo.Template";
          if (celRuleApplies) {
            const ownSchema = e.definition!.schema as Record<string, any>;
            const own = buildEvalPaths(ownSchema);
            const capabilityDef = capability ? defs.resolve(capability) : undefined;
            const parent = capabilityDef?.schema
              ? buildEvalPaths(capabilityDef.schema as Record<string, any>)
              : { compile: [], runtime: [] };
            celEvalPaths = [...own.compile, ...own.runtime, ...parent.compile, ...parent.runtime];
            celRegionScopes = extractCelRegionScopes(ownSchema);
          } else {
            celEvalPaths = [];
            celRegionScopes = [];
          }
        },
        onCel: (e) => {
          const m = e.source;
          const resource = { kind: m.kind, name: m.metadata?.name as string };
          const filePath = (m.metadata as { source?: string } | undefined)?.source;
          const { expr, path, engineName, matchedScope } = e;

          // A `!cel` (or `${{ }}`) in a field with no `x-telo-eval` / `x-telo-context`
          // is never evaluated — the runtime reads it as a literal (e.g. a
          // `concurrency` `!cel` that silently degraded to a sparse `[null, …]`).
          // Flag it rather than letting it pass as valid CEL. Inline resources
          // (resource-wide invocation context) carry CEL the kernel evaluates.
          if (
            celRuleApplies &&
            engineName === "cel" &&
            celInvocationContext === undefined &&
            !evalPathsCover(celEvalPaths, path) &&
            !celRegionScopes.some((scope) => pathMatchesScope(path, scope)) &&
            !pathCrossesNestedResource(m, path)
          ) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "CEL_IN_NON_EVAL_FIELD",
              source: SOURCE,
              message: `${m.kind}/${resource.name}: CEL at '${path}' is never evaluated — the field has no x-telo-eval / x-telo-context annotation, so its value is read as a literal. Annotate the field as a CEL slot or remove the !cel tag.`,
              data: { resource, filePath, path },
            });
            return;
          }

          let matchedContext: Record<string, any> | undefined =
            e.contextSchema ?? celInvocationContext;

          if (celStepContextSchema) {
            const base =
              matchedContext ?? { type: "object", properties: {}, additionalProperties: true };
            matchedContext = {
              ...base,
              properties: {
                ...(base.properties ?? {}),
                steps: celStepContextSchema,
              },
            };
          }

          // `error` is only in scope inside an error-bearing branch (e.g. a
          // `catch:` / `finally:`), so it's merged per-path, not resource-wide.
          const errorSchema =
            celErrorScopes.size > 0 ? errorContextForPath(path, celErrorScopes) : undefined;
          if (errorSchema) {
            const base =
              matchedContext ?? { type: "object", properties: {}, additionalProperties: true };
            matchedContext = {
              ...base,
              properties: {
                ...(base.properties ?? {}),
                error: errorSchema,
              },
            };
          }

          let effectiveContext: Record<string, any> | null = null;
          if (matchedContext) {
            const manifestItem = matchedScope
              ? getManifestItem(path, matchedScope, m as Record<string, any>)
              : (m as Record<string, any>);
            const rootForResolver = manifestRootForResolver(
              m as Record<string, any>,
              defs,
              aliases,
              allManifests as Record<string, any>[],
            );
            const resolvedContext = resolveContextAnnotations(matchedContext, manifestItem, {
              manifestRoot: rootForResolver,
              defs,
              aliases,
              allManifests: allManifests as Record<string, any>[],
            });
            effectiveContext = mergeKernelGlobalsIntoContext(resolvedContext, kernelGlobals);
          }

          const engine = defaultRegistry().get(engineName);
          if (!engine) {
            // No registered engine owns this tag — the expression would go
            // entirely unanalyzed. Surface it rather than skipping silently.
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "UNKNOWN_ENGINE",
              source: SOURCE,
              message: `${m.kind}/${resource.name}: no templating engine registered for '!${engineName}' at '${path}'.`,
              data: { resource, filePath, path },
            });
            return;
          }
          const findings = engine.analyze(expr, { celEnv: this.celEnv, contextSchema: effectiveContext });
          for (const f of findings) {
            if (f.code === "CEL_SYNTAX_ERROR") {
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: "CEL_SYNTAX_ERROR",
                source: SOURCE,
                message: `CEL syntax error at ${path}: ${f.message}`,
                data: { resource, filePath, path },
              });
            } else if (f.code === "CEL_UNKNOWN_FIELD") {
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: "CEL_UNKNOWN_FIELD",
                source: SOURCE,
                message: `${m.kind}/${resource.name}: CEL at '${path}': ${f.message}`,
                data: { resource, filePath, path },
              });
            } else if (f.code === "CEL_NULLABLE_ACCESS") {
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: "CEL_NULLABLE_ACCESS",
                source: SOURCE,
                message: `${m.kind}/${resource.name}: CEL at '${path}': ${f.message}`,
                data: { resource, filePath, path },
              });
            } else {
              // Unknown code from a future engine — pass the message through,
              // tagged with a generic ENGINE_DIAGNOSTIC code so downstream
              // filters can still bucket it.
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: f.code ?? "ENGINE_DIAGNOSTIC",
                source: SOURCE,
                message: `${m.kind}/${resource.name}: !${engineName} at '${path}': ${f.message}`,
                data: { resource, filePath, path },
              });
            }
          }
        },
      },
      { aliases },
    );

    // Validate resource references (Phase 3)
    diagnostics.push(
      ...validateReferences(allManifests, { aliases, definitions: defs, aliasesByModule }),
    );

    // Validate step `invoke` references — the slots the reference field map
    // deliberately skips (behind the step `$ref`), so a missing instance or a
    // kind-instead-of-instance ref there is caught statically, not at runtime.
    diagnostics.push(...validateStepInvokeReferences(allManifests, defs, aliases));

    // Validate `extends` fields and flag legacy `capability: <UserAbstract>` overload.
    diagnostics.push(...validateExtends(allManifests, defs, aliases));

    diagnostics.push(...validateBaseMapping(allManifests, defs, aliases));

    // Validate provider coherence rules for `provide:` template-target definitions.
    diagnostics.push(...validateProviderCoherence(allManifests, defs, aliases));

    // Warn about exported kinds lacking a metadata.description (semantic-search input).
    diagnostics.push(...validateKindDescriptions(allManifests));

    // Validate throws: declarations and catches: coverage (rules 1, 2, 4, 7)
    diagnostics.push(
      ...validateThrowsCoverage(allManifests, defs, aliases, this.celEnv, aliasesByModule, rootModules),
    );

    // Warn about declared variables / secrets / ports that no CEL references.
    diagnostics.push(...validateUnusedDeclarations(allManifests, this.celEnv));

    // Reroute diagnostics on synthetic (inline-extracted) resources back to
    // the chain root so position-index lookups land on the parent doc.
    return rewriteSyntheticOrigins(diagnostics, allManifests);
  }

  analyzeErrors(
    manifests: ResourceManifest[],
    options?: AnalysisOptions,
    registry?: AnalysisRegistry,
  ): AnalysisDiagnostic[] {
    return this.analyze(manifests, options, registry).filter(
      (d) => d.severity === DiagnosticSeverity.Error,
    );
  }

  normalize(
    manifests: ResourceManifest[],
    registry: AnalysisRegistry,
    // Forwarded foreign exports used only as cross-module resolution targets (see
    // resolveRefSentinels). The kernel passes its analyzer-flattened set so the
    // entry-only runtime pass can still resolve `!ref Alias.name`.
    crossModuleTargets?: ResourceManifest[],
  ): ResourceManifest[] {
    const ctx = registry._context();
    const normalized = normalizeInlineResources(
      manifests,
      ctx.definitions!,
      ctx.aliases,
      ctx.aliasesByModule,
    );
    // Resolve !ref sentinels after normalize so both the original and
    // inline-extracted manifests get their refs canonicalized to
    // {kind, name} for the kernel that consumes this output.
    resolveRefSentinels(normalized, ctx.aliases, ctx.aliasesByModule, crossModuleTargets ?? []);
    // Canonicalize import-scoped schema `$ref`s (`telo://Self|Alias/Type`) so the
    // kernel that executes this output compiles inputs/outputs against the same
    // ids the type controllers register their schemas under.
    resolveSchemaTypeRefs(normalized, ctx.aliases, ctx.aliasesByModule);
    return normalized;
  }

  prepare(
    manifests: ResourceManifest[],
    registry: AnalysisRegistry,
  ): { diagnostics: AnalysisDiagnostic[]; order: string[] | null; cycleError: string | null } {
    const ctx = registry._context();
    const diagnostics = validateReferences(manifests, ctx);
    const errors = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);
    if (errors.length > 0) {
      return { diagnostics: errors, order: null, cycleError: null };
    }
    const graph = buildDependencyGraph(
      manifests,
      ctx.definitions!,
      ctx.aliases,
      ctx.aliasesByModule,
    );
    if (graph.cycle) {
      return { diagnostics: [], order: null, cycleError: formatCycle(graph.cycle) };
    }
    return {
      diagnostics: [],
      order: graph.order ? graph.order.map((n) => n.name) : null,
      cycleError: null,
    };
  }
}
