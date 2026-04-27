import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { Environment } from "@marvec/cel-vm";
import { AliasResolver } from "./alias-resolver.js";
import { AnalysisRegistry } from "./analysis-registry.js";
import {
  buildCelEnvironment,
  buildTypedCelEnvironment,
  type CelHandlers,
} from "./cel-environment.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { buildDependencyGraph, formatCycle } from "./dependency-graph.js";
import { buildKernelGlobalsSchema, mergeKernelGlobalsIntoContext } from "./kernel-globals.js";
import { computeSuggestKind } from "./kind-suggest.js";
import { isModuleKind } from "./module-kinds.js";
import { normalizeInlineResources } from "./normalize-inline-resources.js";
import {
  celTypeSatisfiesJsonSchema,
  substituteCelFields,
  validateAgainstSchema,
  type SchemaIssue,
} from "./schema-compat.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type AnalysisOptions } from "./types.js";
import {
  extractAccessChains,
  getManifestItem,
  pathMatchesScope,
  resolveContextAnnotations,
  resolveTypeFieldToSchema,
  validateChainAgainstSchema,
} from "./validate-cel-context.js";
import { validateExtends } from "./validate-extends.js";
import { validateReferences } from "./validate-references.js";
import { validateThrowsCoverage } from "./validate-throws-coverage.js";

const TEMPLATE_REGEX = /\$\{\{\s*([^}]+?)\s*\}\}/g;

function walkCelExpressions(
  value: unknown,
  path: string,
  cb: (expr: string, path: string) => void,
): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(TEMPLATE_REGEX)) {
      cb(m[1].trim(), path);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => walkCelExpressions(v, `${path}[${i}]`, cb));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkCelExpressions(v, path ? `${path}.${k}` : k, cb);
    }
  }
}

const SOURCE = "telo-analyzer";

/**
 * Walk a JSON Schema tree and collect all `x-telo-context` annotations,
 * returning them as `{ scope, schema }` pairs using JSONPath-style scopes —
 * the same format the analyzer uses for CEL context validation.
 */
function extractContextsFromSchema(
  schema: Record<string, any>,
  path = "$",
): Array<{ scope: string; schema: Record<string, any> }> {
  if (!schema || typeof schema !== "object") return [];
  const results: Array<{ scope: string; schema: Record<string, any> }> = [];

  if (schema["x-telo-context"]) {
    results.push({ scope: path, schema: schema["x-telo-context"] });
  }

  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties as Record<string, any>)) {
      results.push(...extractContextsFromSchema(value, `${path}.${key}`));
    }
  }

  if (schema.items && typeof schema.items === "object") {
    results.push(...extractContextsFromSchema(schema.items, `${path}[*]`));
  }

  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const subschema of schema[key]) {
        results.push(...extractContextsFromSchema(subschema, path));
      }
    }
  }

  return results;
}

/**
 * Build a `steps` context schema from `x-telo-step-context` annotation.
 * Walks each step in the manifest array, resolves the invoked resource's outputType,
 * and builds `steps.<name>.result` context entries.
 */
function buildStepContextSchema(
  manifest: Record<string, any>,
  defSchema: Record<string, any>,
  allManifests: Record<string, any>[],
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

    const stepProperties: Record<string, any> = {};
    const collectSteps = (items: unknown[]) => {
      for (const step of items) {
        if (!step || typeof step !== "object") continue;
        const s = step as Record<string, any>;
        const name = s.name;
        if (typeof name === "string") {
          const invoke = s[invokeField] as Record<string, any> | undefined;
          let outputSchema: Record<string, any> | undefined;
          if (invoke && typeof invoke === "object") {
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
          }
          stepProperties[name] = {
            type: "object",
            properties: {
              result: outputSchema ?? { type: "object", additionalProperties: true },
            },
          };
        }
        // Recurse into nested step arrays (then, else, do, catch, finally, try, default, cases)
        for (const nested of ["then", "else", "do", "catch", "finally", "try", "default"]) {
          if (Array.isArray(s[nested])) collectSteps(s[nested]);
        }
        // cases is an object map of arrays
        if (s.cases && typeof s.cases === "object") {
          for (const arr of Object.values(s.cases)) {
            if (Array.isArray(arr)) collectSteps(arr);
          }
        }
      }
    };
    collectSteps(steps);

    if (Object.keys(stepProperties).length > 0) {
      return {
        type: "object",
        properties: stepProperties,
      };
    }
  }

  return undefined;
}

const CEL_PURE_RE = /^\s*\$\{\{[^}]*\}\}\s*$/;
const CEL_EXPR_RE = /\$\{\{\s*([^}]+?)\s*\}\}/;

/** Recursively walk `data`+`schema` together. cel-vm has no `env.check()` for return-type
 *  inference, so on this branch we only catch *syntax / arity / undeclared-function* errors
 *  via `env.compile()`. Mismatches between a CEL expression's actual return type and the
 *  declaring field's JSON-schema type are NOT detected. */
function collectCelTypeIssues(
  data: unknown,
  schema: Record<string, any>,
  path: string,
  definition: { schema?: Record<string, any> },
  manifest: ResourceManifest,
  baseTypedEnv: Environment,
  rootEnv: Environment,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  if (typeof data === "string" && CEL_PURE_RE.test(data)) {
    const exprMatch = data.match(CEL_EXPR_RE);
    if (exprMatch) {
      const expr = exprMatch[1].trim();
      let typedEnv = baseTypedEnv;
      if (definition.schema) {
        for (const ctx of extractContextsFromSchema(definition.schema)) {
          if (!pathMatchesScope(path, ctx.scope)) continue;
          typedEnv = buildTypedCelEnvironment(rootEnv, manifest, ctx.schema);
          break;
        }
      }
      try {
        typedEnv.compile(expr);
      } catch (e) {
        const message = String(e instanceof Error ? e.message : e).split("\n")[0].trim();
        issues.push({ message: `CEL type error: ${message}`, path });
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
        ),
      );
    }
  } else if (data !== null && typeof data === "object") {
    const props = (schema.properties ?? {}) as Record<string, any>;
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      issues.push(
        ...collectCelTypeIssues(
          v,
          (props[k] ?? {}) as Record<string, any>,
          path ? `${path}.${k}` : k,
          definition,
          manifest,
          baseTypedEnv,
          rootEnv,
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

  analyze(
    manifests: ResourceManifest[],
    options?: AnalysisOptions,
    registry?: AnalysisRegistry,
  ): AnalysisDiagnostic[] {
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
    const aliasesByModule = new Map<string, AliasResolver>();
    for (const m of manifests) {
      if (isModuleKind(m.kind)) {
        const namespace = ((m.metadata as any).namespace as string | undefined) ?? null;
        const moduleName = m.metadata.name as string;
        if (moduleName) defs.registerModuleIdentity(namespace, moduleName);
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
        if (alias && source) {
          const targetModule =
            resolvedModuleName ?? source.split("/").filter(Boolean).pop() ?? source;
          // Module identity is registered globally so x-telo-ref resolution sees
          // transitively-imported modules regardless of which scope brought them in.
          if (resolvedModuleName) {
            defs.registerModuleIdentity(resolvedNamespace ?? null, resolvedModuleName);
          }
          // Alias registration is scoped: consumer imports vs. imported-library imports.
          if (!ownModule || rootModules.has(ownModule)) {
            aliases.registerImport(alias, targetModule, exportedKinds);
          } else {
            let libResolver = aliasesByModule.get(ownModule);
            if (!libResolver) {
              libResolver = new AliasResolver();
              aliasesByModule.set(ownModule, libResolver);
            }
            libResolver.registerImport(alias, targetModule, exportedKinds);
          }
        }
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

    // Phase 2: extract inline resources from x-telo-ref slots into first-class manifests
    const allManifests = normalizeInlineResources(manifests, defs, aliases);

    // Build a name→manifest map for looking up referenced resources
    const byName = new Map<string, ResourceManifest>();
    for (const m of allManifests) {
      if (m.metadata?.name) {
        byName.set(m.metadata.name as string, m);
      }
    }

    // Build typed kernel globals schema so x-telo-context chain validation
    // recognises variables, secrets, resources, env automatically
    const kernelGlobals = buildKernelGlobalsSchema(allManifests);

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
      if (m.kind === "Telo.Definition" || m.kind === "Telo.Abstract") {
        continue;
      }

      const resource = { kind: m.kind, name: m.metadata?.name as string };

      // Resolve kind through alias if needed; direct lookup takes priority so that
      // aliases whose name matches the module name (the common case) work without
      // path-derived name mangling.
      const resolvedKind = aliases.resolveKind(m.kind);
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

      // Validate resource config against definition schema.
      // `kind` and `metadata` are implicit on every resource — inject them so module
      // authors don't have to repeat them when using additionalProperties: false.
      if (definition.schema) {
        const schema =
          definition.schema.additionalProperties === false
            ? {
                ...definition.schema,
                properties: {
                  kind: { type: "string" },
                  metadata: { type: "object" },
                  ...definition.schema.properties,
                },
              }
            : definition.schema;
        // Phase 1: CEL type checking — walk data+schema together, check env.check() return types
        const baseTypedEnv = buildTypedCelEnvironment(this.celEnv, m);
        const celIssues = collectCelTypeIssues(m, schema, "", definition, m, baseTypedEnv, this.celEnv);
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

      // (Invocation context compatibility check is handled via x-telo-context in the CEL pass below)
    }

    // Validate CEL syntax and context variable access in all manifests
    for (const m of allManifests) {
      const resource = { kind: m.kind, name: m.metadata?.name as string };
      const filePath = (m.metadata as { source?: string } | undefined)?.source;

      const resolvedKind = aliases.resolveKind(m.kind);
      const mDefinition =
        defs.resolve(m.kind) ?? (resolvedKind ? defs.resolve(resolvedKind) : undefined);

      // Pre-compute step context for manifests with x-telo-step-context
      const stepContextSchema = mDefinition?.schema
        ? buildStepContextSchema(
            m as Record<string, any>,
            mDefinition.schema as Record<string, any>,
            allManifests as Record<string, any>[],
          )
        : undefined;

      walkCelExpressions(m, "", (expr, path) => {
        try {
          this.celEnv.compile(expr);
        } catch (e) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "CEL_SYNTAX_ERROR",
            source: SOURCE,
            message: `CEL syntax error at ${path}: ${e instanceof Error ? e.message : String(e)}`,
            data: { resource, filePath, path },
          });
          return;
        }

        const accessChains = extractAccessChains(expr);

        const contexts = mDefinition?.schema ? extractContextsFromSchema(mDefinition.schema) : [];
        const invocationContext = (m.metadata as any)?.xTeloInvocationContext as
          | Record<string, any>
          | undefined;

        // If no static context but we have step context, inject it
        if (contexts.length === 0 && !invocationContext && !stepContextSchema) return;

        let matchedContext: Record<string, any> | undefined;
        let matchedScope: string | undefined;
        for (const ctx of contexts) {
          if (pathMatchesScope(path, ctx.scope)) {
            matchedContext = ctx.schema;
            matchedScope = ctx.scope;
            break;
          }
        }
        if (!matchedContext) matchedContext = invocationContext;

        // Merge step context into the effective context
        if (stepContextSchema) {
          const base = matchedContext ?? { type: "object", properties: {}, additionalProperties: true };
          matchedContext = {
            ...base,
            properties: {
              ...(base.properties ?? {}),
              steps: stepContextSchema,
            },
          };
        }

        if (!matchedContext) return;

        const manifestItem = matchedScope
          ? getManifestItem(path, matchedScope, m as Record<string, any>)
          : (m as Record<string, any>);
        const resolvedContext = resolveContextAnnotations(
          matchedContext,
          manifestItem,
          allManifests as Record<string, any>[],
        );
        const effectiveContext = mergeKernelGlobalsIntoContext(resolvedContext, kernelGlobals);

        for (const chain of accessChains) {
          const err = validateChainAgainstSchema(chain, effectiveContext);
          if (!err) continue;
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "CEL_UNKNOWN_FIELD",
            source: SOURCE,
            message: `${m.kind}/${resource.name}: CEL at '${path}': ${err}`,
            data: { resource, filePath, path },
          });
        }
      });
    }

    // Validate resource references (Phase 3)
    diagnostics.push(...validateReferences(allManifests, { aliases, definitions: defs }));

    // Validate `extends` fields and flag legacy `capability: <UserAbstract>` overload.
    diagnostics.push(...validateExtends(allManifests, defs, aliases));

    // Validate throws: declarations and catches: coverage (rules 1, 2, 4, 7)
    diagnostics.push(...validateThrowsCoverage(allManifests, defs, aliases, this.celEnv));

    return diagnostics;
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

  normalize(manifests: ResourceManifest[], registry: AnalysisRegistry): ResourceManifest[] {
    const ctx = registry._context();
    return normalizeInlineResources(manifests, ctx.definitions!, ctx.aliases);
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
    const graph = buildDependencyGraph(manifests, ctx.definitions!, ctx.aliases);
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
