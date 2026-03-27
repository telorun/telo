import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { AliasResolver } from "./alias-resolver.js";
import { AnalysisRegistry } from "./analysis-registry.js";
import { celEnvironment } from "./cel-environment.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { buildDependencyGraph, formatCycle } from "./dependency-graph.js";
import { normalizeInlineResources } from "./normalize-inline-resources.js";
import { checkSchemaCompatibility, validateAgainstSchema } from "./schema-compat.js";
import { resolveScope } from "./scope-resolver.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type AnalysisOptions } from "./types.js";
import {
  extractAccessChains,
  pathMatchesScope,
  validateChainAgainstSchema,
} from "./validate-cel-context.js";
import { validateReferences } from "./validate-references.js";

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

export class StaticAnalyzer {
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
    // The root Kernel.Module provides its own identity; imported modules surface their
    // identity via resolvedModuleName/resolvedNamespace stamped onto the Kernel.Import
    // by the loader (so we don't need to include imported Kernel.Module manifests in
    // the analysis set, avoiding false reference errors in the parent context).
    for (const m of manifests) {
      if (m.kind === "Kernel.Module") {
        const namespace = ((m.metadata as any).namespace as string | undefined) ?? null;
        const moduleName = m.metadata.name as string;
        if (moduleName) defs.registerModuleIdentity(namespace, moduleName);
      }
      if (m.kind === "Kernel.Import") {
        const alias = m.metadata.name as string;
        const source = (m as any).source as string | undefined;
        const exportedKinds: string[] = (m as any).exports?.kinds ?? [];
        const resolvedModuleName = (m.metadata as any).resolvedModuleName as string | undefined;
        const resolvedNamespace = (m.metadata as any).resolvedNamespace as
          | string
          | null
          | undefined;
        if (alias && source) {
          const targetModule =
            resolvedModuleName ?? source.split("/").filter(Boolean).pop() ?? source;
          aliases.registerImport(alias, targetModule, exportedKinds);
          if (resolvedModuleName) {
            defs.registerModuleIdentity(resolvedNamespace ?? null, resolvedModuleName);
          }
        }
      }
    }

    // Register definitions from Kernel.Definition resources.
    // Normalize alias-prefixed `capability` to canonical form so extendedBy lookup works
    // (e.g. "Workflow.Backend" → "workflow.Backend" when "Workflow" is a known alias).
    for (const m of manifests) {
      if (m.kind === "Kernel.Definition") {
        const def = m as unknown as ResourceDefinition;
        const resolvedCapability = def.capability
          ? (aliases.resolveKind(def.capability) ?? def.capability)
          : def.capability;
        defs.register(
          resolvedCapability !== def.capability ? { ...def, capability: resolvedCapability } : def,
        );
      }
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

    // Validate each non-definition, non-system resource
    for (const m of allManifests) {
      if (m.kind === "Kernel.Definition" || m.kind === "Kernel.Abstract") {
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
        const knownAliases = aliases.knownAliases();
        const knownKinds = defs.kinds();
        const parts: string[] = [];
        if (knownAliases.length > 0) parts.push(`imports: ${knownAliases.join(", ")}`);
        if (knownKinds.length > 0) parts.push(`kinds: ${knownKinds.join(", ")}`);
        const hint = parts.length > 0 ? ` Known ${parts.join(" | ")}` : "";
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "UNDEFINED_KIND",
          source: SOURCE,
          message: `No Kernel.Definition found for kind '${m.kind}'.${hint}`,
          data: { resource, path: "kind" },
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
        const issues = validateAgainstSchema(m, schema);
        for (const issue of issues) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCHEMA_VIOLATION",
            source: SOURCE,
            message: `${m.kind}/${resource.name}: ${issue.message}`,
            data: { resource, path: issue.path },
          });
        }
      }

      // Check invocation context compatibility
      if (definition.contexts) {
        for (const ctx of definition.contexts) {
          const referencedNames = resolveScope(m as Record<string, any>, ctx.scope);
          for (const refName of referencedNames) {
            const refManifest = byName.get(refName);
            if (!refManifest) {
              diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                code: "UNRESOLVED_REFERENCE",
                source: SOURCE,
                message: `${m.kind}/${resource.name}: scope '${ctx.scope}' references '${refName}' which is not defined in this manifest`,
                data: { resource, path: ctx.scope },
              });
              continue;
            }

            const refKind = aliases.resolveKind(refManifest.kind) ?? refManifest.kind;
            const refDefinition = defs.resolve(refKind);
            if (!refDefinition?.inputs) continue;

            const result = checkSchemaCompatibility(ctx.schema, refDefinition.inputs);
            if (!result.compatible) {
              const severity = options?.strictContexts
                ? DiagnosticSeverity.Error
                : DiagnosticSeverity.Warning;
              for (const issue of result.issues) {
                diagnostics.push({
                  severity,
                  code: "CONTEXT_INCOMPATIBLE",
                  source: SOURCE,
                  message: `${m.kind}/${resource.name} → ${refManifest.kind}/${refName}: ${issue}`,
                  data: { resource, path: ctx.scope },
                });
              }
            }
          }
        }
      }
    }

    // Validate CEL syntax and context variable access in all manifests
    for (const m of allManifests) {
      const resource = { kind: m.kind, name: m.metadata?.name as string };

      const resolvedKind = aliases.resolveKind(m.kind);
      const mDefinition =
        defs.resolve(m.kind) ?? (resolvedKind ? defs.resolve(resolvedKind) : undefined);

      walkCelExpressions(m, "", (expr, path) => {
        let parsed: ReturnType<typeof celEnvironment.parse> | undefined;
        try {
          parsed = celEnvironment.parse(expr);
        } catch (e) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "CEL_SYNTAX_ERROR",
            source: SOURCE,
            message: `CEL syntax error at ${path}: ${e instanceof Error ? e.message : String(e)}`,
            data: { resource, path },
          });
          return;
        }

        if (!mDefinition?.contexts) return;
        for (const ctx of mDefinition.contexts) {
          if (!pathMatchesScope(path, ctx.scope)) continue;
          for (const chain of extractAccessChains(parsed.ast)) {
            const err = validateChainAgainstSchema(chain, ctx.schema);
            if (!err) continue;
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "CEL_UNKNOWN_FIELD",
              source: SOURCE,
              message: `${m.kind}/${resource.name}: CEL at '${path}': ${err}`,
              data: { resource, path },
            });
          }
        }
      });
    }

    // Validate resource references (Phase 3)
    diagnostics.push(...validateReferences(allManifests, { aliases, definitions: defs }));

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
