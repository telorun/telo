import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { findDynamicLeaf } from "./resource-rule.js";
import { readResourceInputs, readSuppliedResources } from "./resource-input.js";
import { type AnalysisDiagnostic, DiagnosticSeverity } from "./types.js";

const SOURCE = "telo-analyzer";

/** A target library's declared `resources:` block, canonicalized in that
 *  library's own alias scope and stamped onto the `Telo.Import` by
 *  `stampRequiredResources`: entry name → canonical kind. */
type RequiredResources = Record<string, string>;

/**
 * The strict half of {@link readResourceInputs} — the `validate-ref-slots.ts`
 * split applied to the resource-input boundary, and not optional for the same
 * reason: the two sides fail in OPPOSITE directions. An unreadable DECLARATION
 * leaves the library referencing a name nothing stands behind; an unchecked
 * INJECTION hands a library an instance of a kind it never asked for, which
 * surfaces as a method-missing failure inside someone else's module.
 *
 * Two surfaces, scoped the same way every other declaration check is — to the
 * entry's own modules, since a published dependency's block is not the
 * consumer's to fix:
 *
 *  - **The library's own declaration.** Each entry's alias-qualified `kind:` must
 *    resolve in the DECLARING module's scope (`RESOURCE_INPUT_KIND_UNRESOLVED`).
 *    A constraint that resolves to nothing accepts anything, which is the same
 *    hole `X_TELO_REF_UNRESOLVED` exists to close one level down.
 *  - **The injection site.** Every declared entry must be supplied
 *    (`RESOURCE_INPUT_MISSING` — the same failure as a missing required
 *    variable), nothing beyond them may be (`RESOURCE_INPUT_UNKNOWN`), the value
 *    must name a resource that exists (`RESOURCE_INPUT_UNRESOLVED`), and its
 *    kind must satisfy the declared constraint transitively
 *    (`RESOURCE_INPUT_KIND_MISMATCH`).
 *
 * Browser-safe.
 */
export function validateResourceInputs(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  rootModules: Set<string>,
  /** Kind acceptance, transitively — the `checkKind` rule `validate-references`
   *  applies at an ordinary ref slot, passed in rather than re-derived so the
   *  two cannot disagree about what satisfies a constraint. */
  acceptsKind: (suppliedKind: string, requiredKind: string) => boolean,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];

  const isOwn = (module: string | undefined): boolean => !module || rootModules.has(module);

  // --- the library's own declaration -------------------------------------
  for (const m of manifests) {
    if (m.kind !== "Telo.Library") continue;
    const moduleName = m.metadata?.name as string | undefined;
    // Only the entry's own modules, so the declaring scope is always the root
    // alias table — a library analyzed here IS a root module.
    if (!isOwn(moduleName)) continue;
    const scope = aliases;
    const exported = new Set(
      (((m as Record<string, any>).exports?.resources ?? []) as unknown[]).filter(
        (e): e is string => typeof e === "string",
      ),
    );
    for (const input of readResourceInputs(m)) {
      // An input is the IMPORTER's instance, borrowed. Exporting it back out
      // would forward a kind-only stand-in into the consumer's flattened set as
      // a resource this library declares — a phantom the consumer can `!ref`
      // and whose kind constraint is all there is behind it. Handing an
      // instance straight back to whoever supplied it is also a relation
      // nothing needs; if it ever does, it should be a decision rather than a
      // name collision nobody noticed.
      if (exported.has(input.name)) {
        out.push({
          severity: DiagnosticSeverity.Error,
          code: "RESOURCE_INPUT_EXPORTED",
          source: SOURCE,
          message:
            `Resource input '${input.name}' is also listed in 'exports.resources'. An input is ` +
            `an instance the importer supplies, not one this library declares, so there is ` +
            `nothing to export — remove it from 'exports.resources', or rename the input.`,
          data: {
            resource: { kind: m.kind, name: moduleName as string },
            filePath: (m.metadata as { source?: string } | undefined)?.source,
            path: `resources.${input.name}`,
          },
        });
      }
      if (registry.resolve(input.kind) ?? registry.resolve(scope.resolveKind(input.kind) ?? "")) {
        continue;
      }
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "RESOURCE_INPUT_KIND_UNRESOLVED",
        source: SOURCE,
        message:
          `Resource input '${input.name}' is constrained to kind '${input.kind}', which does not ` +
          `resolve in this library's scope. Write it alias-qualified — '<Alias>.<Kind>' for an ` +
          `import declared in this file, 'Self.<Kind>' for a kind this library owns, or ` +
          `'Telo.<Kind>' for a built-in. An unresolvable constraint accepts anything.`,
        data: {
          resource: { kind: m.kind, name: moduleName as string },
          filePath: (m.metadata as { source?: string } | undefined)?.source,
          path: `resources.${input.name}.kind`,
        },
      });
    }
  }

  // --- the injection site --------------------------------------------------
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const meta = m.metadata as
      | {
          name?: string;
          module?: string;
          source?: string;
          resolvedModuleName?: string;
          requiredResources?: RequiredResources;
          sharedLibrary?: boolean;
          resolvedSource?: string;
        }
      | undefined;
    const alias = meta?.name;
    if (!alias || !isOwn(meta?.module)) continue;
    // An import whose target identity was never established registers nothing —
    // reporting a missing input against it would blame the author for a
    // dependency the loader has already said it could not obtain.
    if (!meta?.resolvedModuleName) continue;

    // A singleton has no room for a per-import override: `logging:` scopes a
    // subtree that is no longer this import's subtree, and `runtime:` selects a
    // controller backend for a library that is instantiated once. Whichever
    // import happened to be created first would decide, so the field is
    // rejected rather than silently applied to everyone or silently dropped.
    if (meta.sharedLibrary === true) {
      for (const field of ["logging", "runtime"] as const) {
        if ((m as Record<string, unknown>)[field] === undefined) continue;
        out.push({
          severity: DiagnosticSeverity.Error,
          code: "SHARED_LIBRARY_OVERRIDE",
          source: SOURCE,
          message:
            `Import '${alias}' declares '${field}:', but module ` +
            `'${meta.resolvedModuleName}' is 'lifecycle: shared' — one instantiation for the ` +
            `whole application, so a per-import override cannot apply to it. Remove it, or ` +
            `make the library 'lifecycle: isolated'.`,
          data: {
            resource: { kind: m.kind, name: alias },
            filePath: meta.source,
            path: field,
          },
        });
      }
    }

    const required = Object.entries(meta.requiredResources ?? {});
    const supplied = readSuppliedResources(m);
    const declared = new Map(required);
    const resource = { kind: m.kind, name: alias };
    const filePath = meta.source;

    for (const [entryName, entryKind] of required) {
      if (entryName in supplied) continue;
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "RESOURCE_INPUT_MISSING",
        source: SOURCE,
        message:
          `Import '${alias}' does not supply the resource input '${entryName}', which module ` +
          `'${meta.resolvedModuleName}' requires (kind '${entryKind}'). Add ` +
          `\`resources: { ${entryName}: !ref <name> }\` to the import.`,
        data: { resource, filePath, path: "resources" },
      });
    }

    for (const [name, value] of Object.entries(supplied)) {
      const path = `resources.${name}`;
      const entry = declared.get(name);
      if (!entry) {
        const known = required.map(([n]) => n).join(", ") || "(none)";
        out.push({
          severity: DiagnosticSeverity.Error,
          code: "RESOURCE_INPUT_UNKNOWN",
          source: SOURCE,
          message:
            `Import '${alias}' supplies a resource input '${name}', which module ` +
            `'${meta.resolvedModuleName}' does not declare. Declared inputs: ${known}.`,
          data: { resource, filePath, path },
        });
        continue;
      }
      // Phase 2.5 rewrote a resolvable `!ref` to `{kind, name}`; a sentinel that
      // survived names nothing the importer can reach.
      if (isRefSentinel(value)) {
        out.push({
          severity: DiagnosticSeverity.Error,
          code: "RESOURCE_INPUT_UNRESOLVED",
          source: SOURCE,
          message: `Import '${alias}': resource input '${name}' → resource '${value.source}' not found`,
          data: { resource, filePath, path },
        });
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        out.push({
          severity: DiagnosticSeverity.Error,
          code: "RESOURCE_INPUT_UNRESOLVED",
          source: SOURCE,
          message:
            `Import '${alias}': resource input '${name}' must be a '!ref' to a resource this ` +
            `module declares.`,
          data: { resource, filePath, path },
        });
        continue;
      }
      const suppliedKind = (value as { kind?: unknown }).kind;
      if (typeof suppliedKind !== "string") continue;
      const canonical = aliases.resolveKind(suppliedKind) ?? suppliedKind;
      if (acceptsKind(canonical, entry)) continue;
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "RESOURCE_INPUT_KIND_MISMATCH",
        source: SOURCE,
        message:
          `Import '${alias}': resource input '${name}' is '${suppliedKind}' (resolved: ` +
          `'${canonical}'), which does not satisfy the declared constraint '${entry}'.`,
        data: { resource, filePath, path },
      });
    }
  }

  out.push(...sharedLibraryConflicts(manifests, isOwn));

  return out;
}

/** One import's supplied configuration, as the conflict check compares it. */
interface SuppliedConfig {
  readonly alias: string;
  readonly module: string | undefined;
  readonly filePath: string | undefined;
  readonly blocks: ReadonlyMap<string, Record<string, unknown>>;
}

const SUPPLIED_BLOCKS = ["variables", "secrets", "resources"] as const;

/**
 * Two imports of ONE `lifecycle: shared` library supplying different values.
 *
 * The runtime half (`ERR_SHARED_LIBRARY_CONFLICT`) is authoritative — it holds
 * resolved values and live instances, and a library reached through a
 * programmatic load never passed `telo check`. But the overwhelmingly common
 * shape is two literal scalars in one flattened manifest set, which is decidable
 * here, and a conflict is a hard BOOT failure: finding it at `telo check` is the
 * difference between a squiggle and a deployment that will not start.
 *
 * Only what is DECIDABLE is compared, and the two ways it is not are skipped
 * rather than guessed:
 *
 *  - A value holding a `!cel` (at any depth) is known only at load. Two
 *    different expressions may evaluate equal, and identical text in two
 *    different modules may not.
 *  - A `resources:` entry names a resource by name, which means the same
 *    instance only when both imports were DECLARED in the same module — so a
 *    cross-module pair is left to the runtime.
 *
 * Grouped by the target's RESOLVED SOURCE, the identity the kernel keys its
 * singleton registry on; `resolvedModuleName` would collapse two versions of one
 * module, which are two libraries.
 */
function sharedLibraryConflicts(
  manifests: ResourceManifest[],
  isOwn: (module: string | undefined) => boolean,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const byTarget = new Map<string, SuppliedConfig[]>();

  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const meta = m.metadata as
      | { name?: string; module?: string; source?: string; sharedLibrary?: boolean; resolvedSource?: string }
      | undefined;
    if (meta?.sharedLibrary !== true || !meta.name || !meta.resolvedSource) continue;
    const blocks = new Map<string, Record<string, unknown>>();
    for (const block of SUPPLIED_BLOCKS) {
      const value = (m as Record<string, unknown>)[block];
      blocks.set(
        block,
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {},
      );
    }
    const bucket = byTarget.get(meta.resolvedSource);
    const entry: SuppliedConfig = {
      alias: meta.name,
      module: meta.module,
      filePath: meta.source,
      blocks,
    };
    if (bucket) bucket.push(entry);
    else byTarget.set(meta.resolvedSource, [entry]);
  }

  for (const group of byTarget.values()) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    for (const later of rest) {
      for (const block of SUPPLIED_BLOCKS) {
        // A reference means the same instance only within one module's scope.
        if (block === "resources" && first!.module !== later.module) continue;
        const a = first!.blocks.get(block)!;
        const b = later.blocks.get(block)!;
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (findDynamicLeaf(a[key]) || findDynamicLeaf(b[key])) continue;
          if (sameSuppliedValue(a[key], b[key])) continue;
          out.push({
            severity: DiagnosticSeverity.Error,
            code: "SHARED_LIBRARY_CONFLICT",
            source: SOURCE,
            message:
              `Import '${later.alias}' and import '${first!.alias}' both reach a ` +
              `'lifecycle: shared' library — one instantiation for the whole application — but ` +
              `they supply different values for ${block}.${key}. Make the two imports agree, or ` +
              `make the library 'lifecycle: isolated'.`,
            data: isOwn(later.module)
              ? {
                  resource: { kind: "Telo.Import", name: later.alias },
                  filePath: later.filePath,
                  path: `${block}.${key}`,
                }
              : {
                  resource: { kind: "Telo.Import", name: first!.alias },
                  filePath: first!.filePath,
                  path: `${block}.${key}`,
                },
          });
        }
      }
    }
  }

  return out;
}

/** Structural equality, key-order insensitive — the analyzer's half of the rule
 *  the kernel applies to resolved values. A secret's VALUE is compared but never
 *  printed: the key is what the author has to look at. */
function sameSuppliedValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameSuppliedValue(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => sameSuppliedValue(left[key], right[key]));
  }
  return false;
}
