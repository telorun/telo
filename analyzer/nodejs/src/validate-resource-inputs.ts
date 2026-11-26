import type { ResourceManifest } from "@telorun/sdk";
import { isTextRecord, plainScalar } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import { listRequests } from "./declaration-requests.js";
import { importInputsSchema, importTextParameters } from "./import-inputs.js";
import { recordsDifferOnlyInLang, textRecordIdentity, textRecordOf } from "./text-parameter.js";
import { TextLanguageScope } from "./validate-texts.js";
import type { ModuleDocuments } from "./module-documents.js";
import { decodePlainLiterals } from "./plain-literal-decoding.js";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { findDynamicLeaf } from "./resource-rule.js";
import {
  isInjectedDeclaration,
  readResourceInputs,
  readSuppliedResources,
} from "./resource-input.js";
import { type AnalysisDiagnostic, DiagnosticSeverity } from "./types.js";
import { manifestNames } from "./scoped-name-resolver.js";

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
 *  - **The injection site.** Every declared entry not `optional: true` must be
 *    supplied (`RESOURCE_INPUT_MISSING` — the same failure as a missing required
 *    variable), nothing beyond them may be (`RESOURCE_INPUT_UNKNOWN`), the value
 *    must name a resource that exists (`RESOURCE_INPUT_UNRESOLVED`), and its
 *    kind must satisfy the declared constraint transitively
 *    (`RESOURCE_INPUT_KIND_MISMATCH`).
 *
 * Browser-safe.
 */
const declaringModule = (m: ResourceManifest): string | undefined =>
  (m.metadata as { module?: string } | undefined)?.module;

export function validateResourceInputs(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  rootModules: Set<string>,
  /** Kind acceptance, transitively — the `checkKind` rule `validate-references`
   *  applies at an ordinary ref slot, passed in rather than re-derived so the
   *  two cannot disagree about what satisfies a constraint. */
  acceptsKind: (
    suppliedKind: string,
    requiredKind: string,
    suppliedIsDeclaration: boolean,
  ) => boolean,
  /** The imported libraries' documents, whose declared `variables:` /
   *  `secrets:` a supplied literal is decoded against before two are compared. */
  documents: readonly ModuleDocuments[] = [],
): AnalysisDiagnostic[] {
  const isOwn = (module: string | undefined): boolean => !module || rootModules.has(module);
  let names: ReturnType<typeof manifestNames> | undefined;
  const scope: ImportInputScope = {
    aliases,
    acceptsKind,
    isOwn,
    suppliedDeclaration: (name, module) =>
      (names ??= manifestNames(manifests)).resolve(name, module, undefined, (c) => isOwn(declaringModule(c))),
  };
  const out = resourceInputDeclarationDiagnostics(manifests, registry, aliases, isOwn);
  for (const m of manifests) if (m.kind === "Telo.Import") out.push(...importInputDiagnostics(m, scope));
  const texts = new TextLanguageScope(listRequests(manifests), rootModules, documents);
  for (const pair of sharedLibraryPairs(manifests, documents, (m) => texts.langOf(m))) {
    for (const block of SUPPLIED_BLOCKS) {
      for (const key of sharedKeysOf(pair, block)) {
        const found = sharedKeyConflict(pair, block, key, isOwn);
        if (found) out.push(found);
      }
    }
  }
  return out;
}

/** What judging one import's supply reads beside the import. */
export interface ImportInputScope {
  readonly aliases: AliasResolver;
  readonly acceptsKind: (suppliedKind: string, requiredKind: string, suppliedIsDeclaration: boolean) => boolean;
  readonly isOwn: (module: string | undefined) => boolean;
  /** The declaration of the importing module a supplied reference's name
   *  resolves to. */
  readonly suppliedDeclaration: (name: string, module: string | undefined) => ResourceManifest | undefined;
}

/** The library's own declaration: each input's kind resolves, and no input is
 *  exported back out. */
export function resourceInputDeclarationDiagnostics(
  manifests: readonly ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  isOwn: (module: string | undefined) => boolean,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
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
  return out;
}

/** One import of the entry's own modules as the injection site: what it
 *  overrides of a shared library, every required input it leaves out, then
 *  each input it supplies, in written order — the one at `resources.<name>`
 *  judged from the value Phase 2.5 left there. With `entry`, that supplied
 *  input alone. */
export function importInputDiagnostics(
  m: ResourceManifest,
  scope: ImportInputScope,
  entry?: string,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const meta = m.metadata as
    | {
        name?: string;
        module?: string;
        source?: string;
        resolvedModuleName?: string;
        requiredResources?: RequiredResources;
        optionalResources?: readonly string[];
        sharedLibrary?: boolean;
        resolvedSource?: string;
      }
    | undefined;
  const alias = meta?.name;
  if (!alias || !scope.isOwn(meta?.module)) return out;
  // An import whose target identity was never established registers nothing —
  // reporting a missing input against it would blame the author for a
  // dependency the loader has already said it could not obtain.
  if (!meta?.resolvedModuleName) return out;

  // A singleton has no room for a per-import override: `logging:` scopes a
  // subtree that is no longer this import's subtree, and `runtime:` selects a
  // controller backend for a library that is instantiated once. Whichever
  // import happened to be created first would decide, so the field is
  // rejected rather than silently applied to everyone or silently dropped.
  if (meta.sharedLibrary === true && entry === undefined) {
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

  const optional = new Set(meta.optionalResources ?? []);
  for (const [entryName, entryKind] of entry === undefined ? required : []) {
    if (entryName in supplied || optional.has(entryName)) continue;
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
    if (entry !== undefined && name !== entry) continue;
    const path = `resources.${name}`;
    const constraint = declared.get(name);
    if (!constraint) {
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
    const canonical = scope.aliases.resolveKind(suppliedKind) ?? suppliedKind;
    // A library forwarding an input it was itself handed supplies a kind-only
    // stand-in, whose kind is routinely the abstract the target declares. That
    // is identity against an abstract, which an ordinary reference is refused
    // — the referent there would be a resource nothing can instantiate, while
    // here it is another declaration.
    const suppliedName = (value as { name?: unknown }).name;
    const suppliedDeclaration =
      typeof suppliedName === "string" ? scope.suppliedDeclaration(suppliedName, meta?.module) : undefined;
    if (scope.acceptsKind(canonical, constraint, isInjectedDeclaration(suppliedDeclaration))) continue;
    out.push({
      severity: DiagnosticSeverity.Error,
      code: "RESOURCE_INPUT_KIND_MISMATCH",
      source: SOURCE,
      message:
        `Import '${alias}': resource input '${name}' is '${suppliedKind}' (resolved: ` +
        `'${canonical}'), which does not satisfy the declared constraint '${constraint}'.`,
      data: { resource, filePath, path },
    });
  }
  return out;
}

/** One import's supplied configuration, as the conflict check compares it. */
export interface SuppliedConfig {
  readonly alias: string;
  readonly module: string | undefined;
  readonly filePath: string | undefined;
  readonly blocks: ReadonlyMap<string, Record<string, unknown>>;
}

export const SUPPLIED_BLOCKS = ["variables", "secrets", "resources", "needs"] as const;
export type SuppliedBlock = (typeof SUPPLIED_BLOCKS)[number];

/** Two imports of one `lifecycle: shared` library, the earlier first. */
export interface SharedImportPair {
  readonly first: SuppliedConfig;
  readonly later: SuppliedConfig;
  /** The two `Telo.Import` documents, as the pair was read from. */
  readonly imports: readonly [ResourceManifest, ResourceManifest];
}

/** What `m` — a `Telo.Import` of a shared library — supplies, as compared.
 *  `langOf` is the language of the module writing `m`, which a text parameter's
 *  settled record carries. */
export function suppliedConfigOf(
  m: ResourceManifest,
  documents: readonly ModuleDocuments[],
  langOf: (m: ResourceManifest) => string | null,
): SuppliedConfig | undefined {
  const meta = m.metadata as
    | { name?: string; module?: string; source?: string; sharedLibrary?: boolean; resolvedSource?: string }
    | undefined;
  if (meta?.sharedLibrary !== true || !meta.name || !meta.resolvedSource) return undefined;
  const blocks = new Map<string, Record<string, unknown>>();
  // A variable or secret is the value the import builds from what is written —
  // decoded against the library's declaration — so two spellings of one value
  // agree, as at runtime.
  const inputs = importInputsSchema(m, documents);
  // A text parameter is compared as the record it settles to: the importer's
  // text in the importer's language.
  const texts = new Set(importTextParameters(m, documents).map((param) => `${param.block}.${param.name}`));
  for (const block of SUPPLIED_BLOCKS) {
    const value = (m as Record<string, unknown>)[block];
    const written =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const declared = inputs?.properties?.[block]?.properties as Record<string, any> | undefined;
    blocks.set(
      block,
      Object.fromEntries(
        Object.entries(written).map(([key, held]) => [
          key,
          !declared?.[key] || findDynamicLeaf(held)
            ? held
            : texts.has(`${block}.${key}`) && held !== null
              ? textRecordOf(held, langOf(m), false)
              : decodePlainLiterals(structuredClone(held), declared[key]),
        ]),
      ),
    );
  }
  return { alias: meta.name, module: meta.module, filePath: meta.source, blocks };
}

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
 * Every pair compared, in the order the conflicts are reported: grouped by the
 * target's RESOLVED SOURCE, the identity the kernel keys its singleton registry
 * on (`resolvedModuleName` would collapse two versions of one module, which are
 * two libraries), each later import against the first.
 */
export function sharedLibraryPairs(
  manifests: readonly ResourceManifest[],
  documents: readonly ModuleDocuments[],
  langOf: (m: ResourceManifest) => string | null,
): SharedImportPair[] {
  const byTarget = new Map<string, { config: SuppliedConfig; manifest: ResourceManifest }[]>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const config = suppliedConfigOf(m, documents, langOf);
    if (!config) continue;
    const target = (m.metadata as { resolvedSource?: string }).resolvedSource!;
    const bucket = byTarget.get(target);
    if (bucket) bucket.push({ config, manifest: m });
    else byTarget.set(target, [{ config, manifest: m }]);
  }
  const out: SharedImportPair[] = [];
  for (const group of byTarget.values()) {
    const [first, ...rest] = group;
    for (const later of rest) {
      out.push({ first: first!.config, later: later.config, imports: [first!.manifest, later.manifest] });
    }
  }
  return out;
}

/** The keys of `block` either import of `pair` writes, in compared order. */
export function sharedKeysOf(pair: Pick<SharedImportPair, "first" | "later">, block: SuppliedBlock): string[] {
  return [...new Set([...Object.keys(pair.first.blocks.get(block)!), ...Object.keys(pair.later.blocks.get(block)!)])];
}

/**
 * Whether the two imports of `pair` disagree at `block.key`. Only what is
 * DECIDABLE is compared, and the two ways it is not are skipped rather than
 * guessed:
 *
 *  - A value holding a `!cel` (at any depth) is known only at load. Two
 *    different expressions may evaluate equal, and identical text in two
 *    different modules may not.
 *  - A `resources:` entry names a resource by name, which means the same
 *    instance only when both imports were DECLARED in the same module — so a
 *    cross-module pair is left to the runtime. A need supplied whole by `!ref`
 *    is the same case. Whether an import supplies an input at all is literal
 *    in every module, so one supplying it and one omitting it is compared
 *    across modules too.
 */
export function sharedKeyConflict(
  pair: Pick<SharedImportPair, "first" | "later">,
  block: SuppliedBlock,
  key: string,
  isOwn: (module: string | undefined) => boolean,
): AnalysisDiagnostic | undefined {
  const { first, later } = pair;
  const a = first.blocks.get(block)!;
  const b = later.blocks.get(block)!;
  // Whether an import supplies a resource input is a literal fact in every
  // module; which instance it names is one only within one module.
  if (block === "resources" && Object.hasOwn(a, key) !== Object.hasOwn(b, key)) {
    const [supplier, omitter] = Object.hasOwn(a, key) ? [first, later] : [later, first];
    return sharedConflict(
      later,
      first,
      isOwn,
      `${block}.${key}`,
      `import '${supplier.alias}' supplies the resource input ${block}.${key} and import ` +
        `'${omitter.alias}' omits it, so the one instantiation would both borrow it and do ` +
        `without it. Supply it at both imports, omit it at both, or make the library ` +
        `'lifecycle: isolated'.`,
    );
  }
  // A reference means the same instance only within one module's scope.
  if (block === "resources" && first.module !== later.module) return undefined;
  if (findDynamicLeaf(a[key]) || findDynamicLeaf(b[key])) return undefined;
  // A need supplied whole names a need or fulfilment of the importer — the
  // same one only within one module, like a resource input.
  if (block === "needs" && (isRefSentinel(a[key]) || isRefSentinel(b[key])) && first.module !== later.module) {
    return undefined;
  }
  if (isTextRecord(a[key]) && isTextRecord(b[key])) {
    // One text is one settled record: its identity, context, language.
    const identity = textRecordIdentity(a[key]);
    if (identity !== undefined && identity === textRecordIdentity(b[key])) return undefined;
    const langs = recordsDifferOnlyInLang(a[key], b[key]);
    if (langs) {
      return sharedConflict(
        later,
        first,
        isOwn,
        `${block}.${key}`,
        `they supply ${block}.${key} as the same text written in '${langs[0]}' and in '${langs[1]}', ` +
          `which are two texts. Write it from modules of one language, or make the library 'lifecycle: isolated'.`,
      );
    }
  } else if (sameSuppliedValue(a[key], b[key])) return undefined;
  return sharedConflict(
    later,
    first,
    isOwn,
    `${block}.${key}`,
    `they supply different values for ${block}.${key}. Make the two imports agree, or ` +
      `make the library 'lifecycle: isolated'.`,
  );
}

/** One `SHARED_LIBRARY_CONFLICT` between two imports of one shared library, at
 *  the later import where it is one of the entry's own, else at the first. */
function sharedConflict(
  later: SuppliedConfig,
  first: SuppliedConfig,
  isOwn: (module: string | undefined) => boolean,
  path: string,
  detail: string,
): AnalysisDiagnostic {
  const at = isOwn(later.module) ? later : first;
  return {
    severity: DiagnosticSeverity.Error,
    code: "SHARED_LIBRARY_CONFLICT",
    source: SOURCE,
    message:
      `Import '${later.alias}' and import '${first.alias}' both reach a 'lifecycle: shared' ` +
      `library — one instantiation for the whole application — but ${detail}`,
    data: { resource: { kind: "Telo.Import", name: at.alias }, filePath: at.filePath, path },
  };
}

/** Structural equality, key-order insensitive — the analyzer's half of the rule
 *  the kernel applies to resolved values. A secret's VALUE is compared but never
 *  printed: the key is what the author has to look at. */
function sameSuppliedValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  // A decoded value (a URL, an instant, bytes) is the text its plain encoding writes.
  const plainA = plainScalar(a);
  const plainB = plainScalar(b);
  if (plainA !== undefined || plainB !== undefined) return plainA === plainB;
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
