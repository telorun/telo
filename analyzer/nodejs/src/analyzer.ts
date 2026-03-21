import type { ResourceManifest, ResourceDefinition } from "@telorun/sdk";
import { AliasResolver } from "./alias-resolver.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { resolveScope } from "./scope-resolver.js";
import { checkSchemaCompatibility, validateAgainstSchema } from "./schema-compat.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type AnalysisOptions, type AnalysisContext } from "./types.js";
import { validateReferences } from "./validate-references.js";

const SOURCE = "telo-analyzer";

export class StaticAnalyzer {
  analyze(manifests: ResourceManifest[], options?: AnalysisOptions, context?: AnalysisContext): AnalysisDiagnostic[] {
    const diagnostics: AnalysisDiagnostic[] = [];

    // Use pre-seeded registries from context, or create fresh ones.
    // New aliases/definitions found in the manifests are registered into the provided instances
    // so the context accumulates state across successive calls.
    const aliases = context?.aliases ?? new AliasResolver();
    const registry = context?.definitions ?? new DefinitionRegistry();

    // Register aliases from Kernel.Import resources
    for (const m of manifests) {
      if (m.kind === "Kernel.Import") {
        const alias = m.metadata.name as string;
        const source = (m as any).source as string | undefined;
        const exportedKinds: string[] = (m as any).exports?.kinds ?? [];
        if (alias && source) {
          const targetModule =
            (m as any).resolvedModuleName ??
            source.split("/").filter(Boolean).pop() ??
            source;
          aliases.registerImport(alias, targetModule, exportedKinds);
        }
      }
    }

    // Register definitions from Kernel.Definition resources
    for (const m of manifests) {
      if (m.kind === "Kernel.Definition") {
        registry.register(m as unknown as ResourceDefinition);
      }
    }

    // Build a name→manifest map for looking up referenced resources
    const byName = new Map<string, ResourceManifest>();
    for (const m of manifests) {
      if (m.metadata?.name) {
        byName.set(m.metadata.name as string, m);
      }
    }

    // Validate each non-definition, non-system resource
    for (const m of manifests) {
      if (
        m.kind === "Kernel.Definition" ||
        m.kind === "Kernel.Module" ||
        m.kind === "Kernel.Import"
      ) {
        continue;
      }

      const resource = { kind: m.kind, name: m.metadata?.name as string };

      // Resolve kind through alias if needed; direct lookup takes priority so that
      // aliases whose name matches the module name (the common case) work without
      // path-derived name mangling.
      const resolvedKind = aliases.resolveKind(m.kind);
      const definition =
        registry.resolve(m.kind) ??
        (resolvedKind ? registry.resolve(resolvedKind) : undefined);
      if (!definition) {
        const knownAliases = aliases.knownAliases();
        const knownKinds = registry.kinds();
        const parts: string[] = [];
        if (knownAliases.length > 0)
          parts.push(`imports: ${knownAliases.join(", ")}`);
        if (knownKinds.length > 0)
          parts.push(`kinds: ${knownKinds.join(", ")}`);
        const hint = parts.length > 0 ? ` Known ${parts.join(" | ")}` : "";
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "UNDEFINED_KIND",
          source: SOURCE,
          message: `No Kernel.Definition found for kind '${m.kind}'.${hint}`,
          data: { resource },
        });
        continue;
      }

      // Validate resource config against definition schema
      if (definition.schema) {
        const issues = validateAgainstSchema(m, definition.schema);
        for (const issue of issues) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCHEMA_VIOLATION",
            source: SOURCE,
            message: `${m.kind}/${resource.name}: ${issue}`,
            data: { resource },
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
            const refDefinition = registry.resolve(refKind);
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

    // Validate resource references (Phase 3)
    diagnostics.push(...validateReferences(manifests, { aliases, definitions: registry }));

    return diagnostics;
  }
}
