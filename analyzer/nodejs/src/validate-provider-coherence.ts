import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * Validates coherence rules for `Telo.Definition` documents that use the `provide:`
 * template target, plus the implementation-presence rule on `Telo.Provider`
 * definitions.
 *
 * Diagnostics:
 *  - PROVIDE_ON_NON_PROVIDER: `provide:` declared on a definition whose
 *    `capability` is not `Telo.Provider`.
 *  - PROVIDE_DISPATCHER_CONFLICT: `provide:` co-exists with `invoke:` or `run:`
 *    on the same definition.
 *  - PROVIDE_TARGET_UNKNOWN: `provide.name` does not resolve to an entry in
 *    `resources:`.
 *  - PROVIDE_TARGET_NOT_INVOCABLE: `provide.name` resolves to a resource whose
 *    kind is registered but not a `Telo.Invocable`.
 *  - PROVIDER_MISSING_IMPLEMENTATION: definition with `capability: Telo.Provider`
 *    declares neither `controllers:` (TS-backed) nor `provide:` (template-backed).
 *  - MOUNT_ON_NON_MOUNT: `mount:` declared on a definition whose `capability` is
 *    not `Telo.Mount`.
 *  - MOUNT_DISPATCHER_CONFLICT: `mount:` co-exists with another dispatch
 *    entry-point (`invoke:` / `run:` / `provide:`).
 *  - MOUNT_TARGET_UNKNOWN: `mount.name` does not resolve to an entry in
 *    `resources:`.
 *  - MOUNT_TARGET_NOT_MOUNTABLE: `mount.name` resolves to a resource whose kind
 *    is registered but not a `Telo.Mount`.
 */
export function validateProviderCoherence(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];

  const importedModules = new Set<string>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const resolved = (m.metadata as { resolvedModuleName?: string } | undefined)
      ?.resolvedModuleName;
    if (resolved) importedModules.add(resolved);
  }

  for (const m of manifests) {
    if (m.kind !== "Telo.Definition") continue;
    const name = m.metadata?.name as string | undefined;
    if (!name) continue;
    const ownModule = (m.metadata as { module?: string } | undefined)?.module;
    if (ownModule && importedModules.has(ownModule)) continue;
    const filePath = (m.metadata as { source?: string } | undefined)?.source;
    const resource = { kind: m.kind, name };
    const label = `${m.kind}/${name}`;

    const md = m as Record<string, unknown>;
    const capability = typeof md.capability === "string" ? md.capability : undefined;
    const provide = md.provide;
    const invoke = md.invoke;
    const run = md.run;
    const mount = md.mount;
    const controllers = md.controllers;
    const resources = md.resources;

    const hasProvide = provide !== undefined && provide !== null;
    const hasInvoke = invoke !== undefined && invoke !== null;
    const hasRun = run !== undefined && run !== null;
    const hasMount = mount !== undefined && mount !== null;
    const hasControllers = Array.isArray(controllers) && controllers.length > 0;

    if (hasProvide && capability !== "Telo.Provider") {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "PROVIDE_ON_NON_PROVIDER",
        source: SOURCE,
        message:
          `${label}: 'provide:' is only valid on definitions with 'capability: Telo.Provider' ` +
          `(found '${capability ?? "<unset>"}'). Use 'invoke:' or 'run:' for other capabilities.`,
        data: { resource, filePath, path: "provide" },
      });
    }

    if (hasProvide && (hasInvoke || hasRun)) {
      const conflict = hasInvoke ? "invoke" : "run";
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "PROVIDE_DISPATCHER_CONFLICT",
        source: SOURCE,
        message:
          `${label}: 'provide:' cannot co-exist with '${conflict}:'. ` +
          `A definition declares exactly one dispatch entry-point.`,
        data: { resource, filePath, path: "provide" },
      });
    }

    if (hasProvide && typeof provide === "object" && !Array.isArray(provide)) {
      const provideObj = provide as { kind?: unknown; name?: unknown };
      const providedName = typeof provideObj.name === "string" ? provideObj.name : undefined;
      const providedKind = typeof provideObj.kind === "string" ? provideObj.kind : undefined;
      if (providedName && Array.isArray(resources)) {
        const match = resources.find((r) => {
          const meta = (r as { metadata?: { name?: unknown } })?.metadata;
          return typeof meta?.name === "string" && meta.name === providedName;
        }) as { kind?: unknown } | undefined;
        if (!match) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "PROVIDE_TARGET_UNKNOWN",
            source: SOURCE,
            message:
              `${label}: 'provide.name: ${providedName}' does not match any entry's ` +
              `metadata.name in 'resources:'.`,
            data: { resource, filePath, path: "provide.name" },
          });
        } else if (typeof match.kind === "string") {
          // `provide.kind` is the type contract the analyzer uses to type
          // `result` CEL against the target's `outputType`. The runtime
          // dispatches on `provide.name` and ignores `provide.kind`, so a
          // mismatch silently degrades `result` typing to an open schema
          // (and at runtime quietly invokes the actually-matched resource).
          // Flag the divergence so result-typing never lies.
          if (providedKind) {
            const providedCanonical = aliases.resolveKind(providedKind) ?? providedKind;
            const matchCanonical = aliases.resolveKind(match.kind) ?? match.kind;
            if (providedCanonical !== matchCanonical) {
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: "PROVIDE_KIND_MISMATCH",
                source: SOURCE,
                message:
                  `${label}: 'provide.kind: ${providedKind}' disagrees with the matched ` +
                  `'resources:' entry's kind '${match.kind}' (matched by metadata.name ` +
                  `'${providedName}'). The runtime dispatches by name, so 'provide.kind' ` +
                  `is decorative — but the analyzer types 'result:' against it, and a ` +
                  `mismatch silently turns off that typing.`,
                data: { resource, filePath, path: "provide.kind" },
              });
            }
          }
          const resolvedKind = aliases.resolveKind(match.kind) ?? match.kind;
          const targetDef = registry.resolve(resolvedKind) ?? registry.resolve(match.kind);
          if (targetDef && targetDef.kind === "Telo.Definition") {
            const targetCap = (targetDef as { capability?: unknown }).capability;
            if (typeof targetCap === "string" && targetCap !== "Telo.Invocable") {
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: "PROVIDE_TARGET_NOT_INVOCABLE",
                source: SOURCE,
                message:
                  `${label}: 'provide.name: ${providedName}' resolves to a ${match.kind} ` +
                  `(capability '${targetCap}'); 'provide:' requires a Telo.Invocable target.`,
                data: { resource, filePath, path: "provide.name" },
              });
            }
          }
        }
      }
    }

    if (hasMount && capability !== "Telo.Mount") {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "MOUNT_ON_NON_MOUNT",
        source: SOURCE,
        message:
          `${label}: 'mount:' is only valid on definitions with 'capability: Telo.Mount' ` +
          `(found '${capability ?? "<unset>"}'). Use 'invoke:' / 'run:' / 'provide:' for other capabilities.`,
        data: { resource, filePath, path: "mount" },
      });
    }

    if (hasMount && (hasInvoke || hasRun || hasProvide)) {
      const conflict = hasInvoke ? "invoke" : hasRun ? "run" : "provide";
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "MOUNT_DISPATCHER_CONFLICT",
        source: SOURCE,
        message:
          `${label}: 'mount:' cannot co-exist with '${conflict}:'. ` +
          `A definition declares exactly one dispatch entry-point.`,
        data: { resource, filePath, path: "mount" },
      });
    }

    if (hasMount) {
      // Resolve the target's name from either form: the bare string (the
      // primary, documented form — `mount: api`) or the object's `name`. A CEL
      // target (`${{ … }}`) can only be checked at runtime, so skip those.
      let mountedName: string | undefined;
      if (typeof mount === "string") {
        if (!mount.includes("${{")) mountedName = mount;
      } else if (typeof mount === "object" && !Array.isArray(mount)) {
        const mountObj = mount as { name?: unknown };
        if (typeof mountObj.name === "string" && !mountObj.name.includes("${{")) {
          mountedName = mountObj.name;
        }
      }
      const mountPath = typeof mount === "string" ? "mount" : "mount.name";
      if (mountedName && Array.isArray(resources)) {
        const match = resources.find((r) => {
          const meta = (r as { metadata?: { name?: unknown } })?.metadata;
          return typeof meta?.name === "string" && meta.name === mountedName;
        }) as { kind?: unknown } | undefined;
        if (!match) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "MOUNT_TARGET_UNKNOWN",
            source: SOURCE,
            message:
              `${label}: '${mountPath}: ${mountedName}' does not match any entry's ` +
              `metadata.name in 'resources:'.`,
            data: { resource, filePath, path: mountPath },
          });
        } else if (typeof match.kind === "string") {
          const resolvedKind = aliases.resolveKind(match.kind) ?? match.kind;
          const targetDef = registry.resolve(resolvedKind) ?? registry.resolve(match.kind);
          if (targetDef && targetDef.kind === "Telo.Definition") {
            const targetCap = (targetDef as { capability?: unknown }).capability;
            if (typeof targetCap === "string" && targetCap !== "Telo.Mount") {
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: "MOUNT_TARGET_NOT_MOUNTABLE",
                source: SOURCE,
                message:
                  `${label}: '${mountPath}: ${mountedName}' resolves to a ${match.kind} ` +
                  `(capability '${targetCap}'); 'mount:' requires a Telo.Mount target.`,
                data: { resource, filePath, path: mountPath },
              });
            }
          }
        }
      }
    }

    if (capability === "Telo.Provider" && !hasControllers && !hasProvide) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "PROVIDER_MISSING_IMPLEMENTATION",
        source: SOURCE,
        message:
          `${label}: 'capability: Telo.Provider' requires either 'controllers:' ` +
          `(TS-backed) or 'provide:' (template-backed) to declare an implementation.`,
        data: { resource, filePath, path: "capability" },
      });
    }
  }

  return diagnostics;
}
