import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** Alias-form pattern for `extends`: "<Alias>.<AbstractName>", two PascalCase segments. */
const EXTENDS_ALIAS_RE = /^[A-Z][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]*$/;

/**
 * Phase 3b — Validate `extends` fields on Telo.Definition docs, and flag the legacy
 * `capability: <UserAbstract>` overload with CAPABILITY_SHADOWS_EXTENDS so users migrate.
 *
 * `extends` uses alias form ("<Alias>.<Name>") resolved against the declaring file's
 * Telo.Import declarations — same pattern as `kind:` prefixes. The analyzer pre-resolves
 * via AliasResolver before register() is called, so by the time this validator runs,
 * the definition's effective `extends` is either the canonical form (when the alias was
 * known) or the original alias-prefixed string (when it wasn't).
 *
 * Diagnostics:
 *  - EXTENDS_MALFORMED: value not in "<Alias>.<Name>" alias form, or not resolvable
 *    via the declaring file's imports (alias unknown → can't distinguish from a typo).
 *  - EXTENDS_UNKNOWN_TARGET: alias resolves to a module, but that module has no
 *    registered definition with the target name.
 *  - EXTENDS_NON_ABSTRACT: target resolves to a Telo.Definition, not a Telo.Abstract.
 *  - CAPABILITY_SHADOWS_EXTENDS (warning): `capability` names a user-declared abstract
 *    (metadata.module !== "Telo"). Builtin lifecycle capabilities (Telo.Invocable, etc.)
 *    never trigger this — they're lifecycle roles by design.
 */
export function validateExtends(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];

  for (const m of manifests) {
    if (m.kind !== "Telo.Definition") continue;
    const name = m.metadata?.name as string | undefined;
    if (!name) continue;
    const filePath = (m.metadata as { source?: string } | undefined)?.source;
    const resource = { kind: m.kind, name };
    const label = `${m.kind}/${name}`;

    // --- extends validation ---
    // At this point `m.extends` is whatever the manifest declared (alias form, e.g.
    // "Ai.Model"). Resolve through the AliasResolver to the canonical form before
    // looking up the target definition.
    const extendsValue = (m as { extends?: unknown }).extends;
    if (extendsValue !== undefined) {
      if (typeof extendsValue !== "string") {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "EXTENDS_MALFORMED",
          source: SOURCE,
          message: `${label}: 'extends' must be a string in alias form "<Alias>.<Name>"`,
          data: { resource, filePath, path: "extends" },
        });
      } else if (!EXTENDS_ALIAS_RE.test(extendsValue)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "EXTENDS_MALFORMED",
          source: SOURCE,
          message:
            `${label}: 'extends: ${extendsValue}' must be in alias form "<Alias>.<Name>" ` +
            `(e.g. "Ai.Model"), resolved via this file's Telo.Import declarations.`,
          data: { resource, filePath, path: "extends" },
        });
      } else {
        const prefix = extendsValue.slice(0, extendsValue.indexOf("."));
        if (!aliases.hasAlias(prefix)) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "EXTENDS_MALFORMED",
            source: SOURCE,
            message:
              `${label}: 'extends: ${extendsValue}' — alias '${prefix}' is not a Telo.Import ` +
              `in this file's scope. Declare the import or correct the alias.`,
            data: { resource, filePath, path: "extends" },
          });
        } else {
          const canonical = aliases.resolveKind(extendsValue);
          if (!canonical) {
            // Alias exists but the suffix isn't in its exported kinds — behave like
            // an unknown target so users see the symbol is wrong, not that the alias is.
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "EXTENDS_UNKNOWN_TARGET",
              source: SOURCE,
              message: `${label}: 'extends' target '${extendsValue}' is not an exported kind of alias '${prefix}'.`,
              data: { resource, filePath, path: "extends" },
            });
          } else {
            const targetDef = registry.resolve(canonical);
            if (!targetDef) {
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: "EXTENDS_UNKNOWN_TARGET",
                source: SOURCE,
                message: `${label}: 'extends' target '${extendsValue}' (resolved: '${canonical}') is not a registered definition.`,
                data: { resource, filePath, path: "extends" },
              });
            } else if (targetDef.kind !== "Telo.Abstract") {
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: "EXTENDS_NON_ABSTRACT",
                source: SOURCE,
                message:
                  `${label}: 'extends' target '${extendsValue}' (resolved: '${canonical}') is a ${targetDef.kind}, not a Telo.Abstract. ` +
                  `Only Telo.Abstract declarations may be extended.`,
                data: { resource, filePath, path: "extends" },
              });
            }
          }
        }
      }
    }

    // --- legacy capability-as-abstract warning ---
    // `capability` is expected to name either a builtin lifecycle (module "Telo") or a
    // user-declared abstract. The latter is the pre-`extends` overload — emit a warning
    // suggesting the canonical form. Resolve through aliases first because the manifest
    // retains the alias-prefixed form (e.g. "AbstractLib.Greeter"); the registered key
    // is the canonical form after alias resolution (e.g. "abstract-lib.Greeter").
    const capability = (m as { capability?: unknown }).capability;
    if (typeof capability === "string") {
      const resolvedCap = aliases.resolveKind(capability) ?? capability;
      const capDef = registry.resolve(resolvedCap);
      if (
        capDef &&
        capDef.kind === "Telo.Abstract" &&
        capDef.metadata.module !== "Telo"
      ) {
        // Build suggestion using the original alias form if aliases can produce it.
        const aliasesForModule = aliases.aliasesFor(capDef.metadata.module);
        const suggestion =
          aliasesForModule.length > 0
            ? `${aliasesForModule[0]}.${capDef.metadata.name}`
            : `${capDef.metadata.module}.${capDef.metadata.name}`;
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          code: "CAPABILITY_SHADOWS_EXTENDS",
          source: SOURCE,
          message:
            `${label}: 'capability: ${capability}' names a user-declared abstract. ` +
            `Prefer 'extends' for implements-this-abstract declarations; 'capability' should ` +
            `name a lifecycle role. Use \`extends: "${suggestion}"\` with a lifecycle ` +
            `\`capability\` (e.g. Telo.Invocable, Telo.Provider, Telo.Service).`,
          data: { resource, filePath, path: "capability" },
        });
      }
    }
  }

  return diagnostics;
}
