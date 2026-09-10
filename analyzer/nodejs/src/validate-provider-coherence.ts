import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  controllerBearingAncestor,
  inheritedCapability,
  type DefResolver,
} from "./extends-resolution.js";
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
 *  - PROVIDER_MISSING_IMPLEMENTATION: definition with `capability: Telo.Provider`
 *    declares neither `controllers:` (TS-backed) nor `provide:` (template-backed).
 *  - MOUNT_ON_NON_MOUNT: `mount:` declared on a definition whose `capability` is
 *    not `Telo.Mount`.
 *  - MOUNT_DISPATCHER_CONFLICT: `mount:` co-exists with another dispatch
 *    entry-point (`invoke:` / `run:` / `provide:`).
 *
 * What a dispatch slot NAMES — that it is a `!ref`, that the entry exists, that
 * its capability carries the method — is `validate-template-body`'s, for every
 * slot alike.
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
    const resolveDef: DefResolver = (k) =>
      registry.resolve(aliases.resolveKind(k) ?? k) ?? registry.resolve(k);
    // The INHERITED capability, not the declared one: an `extends` child writes
    // none of its own, so reading `md.capability` reported a child that inherits
    // `Telo.Provider` and declares `provide:` as PROVIDE_ON_NON_PROVIDER
    // "(found '<unset>')" — the same defect `celRuleApplies` and
    // `validate-template-body` were fixed for, in the file next door.
    const capability = inheritedCapability(m as ResourceDefinition, resolveDef);
    const provide = md.provide;
    const invoke = md.invoke;
    const run = md.run;
    const mount = md.mount;
    const controllers = md.controllers;

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

    // A definition that inherits a controller by delegation (concrete `extends`,
    // no own controller/template) satisfies the implementation requirement
    // through its parent — `base:` supplies the parent's config.
    const inheritsController =
      typeof md.extends === "string" &&
      controllerBearingAncestor(m as ResourceDefinition, resolveDef) !== undefined;

    if (capability === "Telo.Provider" && !hasControllers && !hasProvide && !inheritsController) {
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
