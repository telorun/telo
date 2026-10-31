/**
 * One configuration's documents: every `!if` / `!switch` outside a template
 * body replaced by the branch it takes there, or by nothing.
 *
 * In a list the chosen branch is one item, or none; as a field's value it is
 * the value, or the key is gone; at a declaration position (a whole document,
 * an `x-telo-scope` member) it is one declaration — the chosen branch's `kind`
 * and fields under the outermost tag's `metadata` — or no declaration. A
 * branch's own tags are expanded in turn. A choice decided as a stand-in
 * claims nothing: at a field or list position it is the opaque value an
 * expression stands in as (`dyn`), at a declaration position the tag's name
 * declared with no kind ({@link isStandInDeclaration}). Kind documents,
 * imports and every module-doc field but `targets:` are left as written.
 *
 * Shared by the analysis (one expansion per configuration) and the kernel
 * (the configuration the process started with), so the two cannot disagree
 * about what a manifest expands to. The returned relocation moves a
 * diagnostic about an expanded document back to the place its author wrote
 * (`then.access`, `cases.postgres.access`, `mounts[2]` for the third item as
 * written).
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import {
  CEL_ENGINE,
  expansionTagLabel,
  expansionTagOf,
  isExpansionSentinel,
  isTaggedSentinel,
  makeTaggedSentinel,
  type ExpansionSentinel,
} from "@telorun/templating";
import { branchKeys, branchValue, pathOf, STAND_IN, type Decisions } from "./choice-reading.js";
import { isModuleKind } from "./module-kinds.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import type { AnalysisDiagnostic } from "./types.js";

type Keys = readonly (string | number)[];

/** Where an expanded position came from. */
interface Mapping {
  readonly from: Keys;
  readonly to: Keys;
  /** For a chosen declaration: where its `metadata` is written (the tag's). */
  readonly metadataAt?: Keys;
  /** Every position beneath `from` is written at `to` itself. */
  readonly exact?: true;
}

/** How one expanded document's diagnostics move back to what was written. */
interface Relocation {
  readonly mappings: Mapping[];
  /** The identity a whole document behind a tag is reported under. */
  readonly resource?: { readonly kind: string; readonly name: string };
}

export interface ChoiceExpansion {
  readonly manifests: ResourceManifest[];
  /** Diagnostics about an expanded document, at their written place. */
  relocate(diagnostics: readonly AnalysisDiagnostic[]): AnalysisDiagnostic[];
  /** How a diagnostic about `manifest` is moved, as text — equal exactly when
   *  the move is. */
  relocationOf(manifest: { readonly kind?: unknown; readonly metadata?: unknown }): string;
}

/**
 * Expand `manifests` — in written order, whole documents behind a tag among
 * them — by `decisions`, keeping that order. A tag `skip` holds — refused, or
 * a choice nothing decided — is left as written; a refused whole document is
 * left out, as every pass leaves it out.
 */
export function expandChoices(
  manifests: readonly ResourceManifest[],
  decisions: Decisions,
  skip?: (sentinel: ExpansionSentinel) => boolean,
  /** Mark each chosen declaration (`metadata.xTeloChoice`): its name is the
   *  choice's, which the choice reading judges once. */
  mark = false,
): ChoiceExpansion {
  const relocations = new Map<string, Relocation>();
  const out: ResourceManifest[] = [];

  const expandTag = (
    sentinel: ExpansionSentinel,
    from: Keys,
    to: Keys,
    mappings: Mapping[],
    metadata: { value: unknown; at: Keys } | undefined,
  ): { present: boolean; value?: unknown } => {
    const branch = decisions.get(sentinel);
    if (branch === undefined) return { present: true, value: sentinel };
    if (branch === null) return { present: false };
    const ownMetadata = (sentinel as Record<string, unknown>).metadata;
    const named = ownMetadata !== undefined ? { value: ownMetadata, at: from } : metadata;
    if (branch === STAND_IN) {
      if (named) {
        mappings.push({ from: to, to: from, metadataAt: named.at });
        return {
          present: true,
          value: { metadata: { ...declaredMetadata(named.value, true), [STAND_IN_MARK]: true } },
        };
      }
      mappings.push({ from: to, to: from });
      return { present: true, value: makeTaggedSentinel(CEL_ENGINE, STAND_IN_SOURCE) };
    }
    const chosen = branchValue(sentinel, branch);
    if (!chosen.written) return { present: false };
    const at = [...from, ...branchKeys(branch)];
    if (isChoice(chosen.value) && !skip?.(chosen.value as ExpansionSentinel)) {
      return expandTag(chosen.value as ExpansionSentinel, at, to, mappings, named);
    }
    if (named) {
      // A branch that is no declaration is refused where it is written, and
      // declares nothing here.
      if (!chosen.value || typeof chosen.value !== "object" || Array.isArray(chosen.value)) {
        return { present: false };
      }
      // A declaration: the branch's kind and fields under the tag's metadata.
      mappings.push({ from: to, to: at, metadataAt: named.at });
      const { kind, ...fields } = chosen.value as Record<string, unknown>;
      const declared: Record<string, unknown> = {
        kind,
        metadata: declaredMetadata(named.value, mark),
      };
      for (const [key, field] of Object.entries(fields)) {
        // A branch's own `metadata` is refused where it is written; the tag's names it.
        if (key === "metadata") continue;
        const r = expandValue(field, [...at, key], [...to, key], mappings);
        if (r.present) declared[key] = r.value;
      }
      return { present: true, value: declared };
    }
    mappings.push({ from: to, to: at });
    return expandValue(chosen.value, at, to, mappings);
  };

  const expandValue = (value: unknown, from: Keys, to: Keys, mappings: Mapping[]): { present: boolean; value?: unknown } => {
    if (isChoice(value) && !skip?.(value as ExpansionSentinel)) {
      return expandTag(value as ExpansionSentinel, from, to, mappings, undefined);
    }
    if (value === null || typeof value !== "object" || isTaggedSentinel(value) || isCompiledValue(value)) {
      return { present: true, value };
    }
    if (isExpansionSentinel(value)) return { present: true, value };
    if (Array.isArray(value)) {
      let changed = false;
      const items: unknown[] = [];
      value.forEach((item, i) => {
        const r = expandValue(item, [...from, i], [...to, items.length], mappings);
        if (!r.present) {
          changed = true;
          return;
        }
        if (r.value !== item || items.length !== i) {
          changed = true;
          if (items.length !== i) mappings.push({ from: [...to, items.length], to: [...from, i] });
        }
        items.push(r.value);
      });
      return { present: true, value: changed ? items : value };
    }
    let changed = false;
    const record: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const r = expandValue(field, [...from, key], [...to, key], mappings);
      if (!r.present) {
        changed = true;
        continue;
      }
      if (r.value !== field) changed = true;
      record[key] = r.value;
    }
    return { present: true, value: changed ? record : value };
  };

  const keyOf = (kind: unknown, name: unknown, source: unknown) => `${kind}\0${name}\0${source}`;

  for (const doc of manifests) {
    if (isExpansionSentinel(doc)) {
      expandDocument(doc);
      continue;
    }
    if (isKindDocumentOrImport(doc)) {
      out.push(doc);
      continue;
    }
    const mappings: Mapping[] = [];
    let expanded: ResourceManifest = doc;
    if (isModuleKind(doc.kind)) {
      const targets = (doc as Record<string, unknown>).targets;
      if (Array.isArray(targets)) {
        const r = expandValue(targets, ["targets"], ["targets"], mappings);
        if (r.value !== targets) expanded = { ...doc, targets: r.value } as ResourceManifest;
      }
    } else {
      const fields: Record<string, unknown> = {};
      let changed = false;
      for (const [key, field] of Object.entries(doc)) {
        if (key === "kind" || key === "metadata") {
          fields[key] = field;
          continue;
        }
        const r = expandValue(field, [key], [key], mappings);
        if (!r.present) {
          changed = true;
          continue;
        }
        if (r.value !== field) changed = true;
        fields[key] = r.value;
      }
      if (changed) expanded = fields as ResourceManifest;
    }
    if (mappings.length > 0) {
      const meta = doc.metadata as { name?: unknown; source?: unknown } | undefined;
      relocations.set(keyOf(doc.kind, meta?.name, meta?.source), { mappings });
    }
    out.push(expanded);
  }

  function expandDocument(document: ResourceManifest): void {
    if (skip?.(document as unknown as ExpansionSentinel) || !isChoice(document)) return;
    const mappings: Mapping[] = [];
    const r = expandTag(document as unknown as ExpansionSentinel, [], [], mappings, undefined);
    // Absent in this configuration, or not decided here.
    if (!r.present || r.value === document) return;
    // The loader's stamps travel on the tag's metadata.
    const declared = r.value as ResourceManifest;
    out.push(declared);
    const meta = declared.metadata as { name?: unknown; source?: unknown } | undefined;
    const label = expansionTagLabel(document)!;
    relocations.set(keyOf(declared.kind, meta?.name, meta?.source), {
      mappings,
      ...(typeof meta?.name === "string" ? { resource: { kind: label, name: meta.name } } : {}),
    });
  }

  const relocate = (diagnostics: readonly AnalysisDiagnostic[]): AnalysisDiagnostic[] => {
    if (relocations.size === 0) return [...diagnostics];
    return diagnostics.map((d) => {
      const data = d.data as
        | { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown }
        | undefined;
      if (!data?.resource) return d;
      const relocation = relocations.get(keyOf(data.resource.kind, data.resource.name, data.filePath));
      if (!relocation) return d;
      const path = typeof data.path === "string" ? relocatePath(data.path, relocation.mappings) : data.path;
      return {
        ...d,
        data: {
          ...(d.data as Record<string, unknown>),
          ...(relocation.resource ? { resource: relocation.resource } : {}),
          ...(path !== undefined ? { path } : {}),
        },
      };
    });
  };

  const relocationOf = (manifest: { readonly kind?: unknown; readonly metadata?: unknown }): string => {
    const meta = manifest.metadata as { name?: unknown; source?: unknown } | undefined;
    return JSON.stringify(relocations.get(keyOf(manifest.kind, meta?.name, meta?.source)) ?? null);
  };

  return { manifests: out, relocate, relocationOf };
}

export const STAND_IN_MARK = "xTeloStandIn";

/** The metadata a chosen declaration carries: the tag's, with the stamps of a
 *  re-export (`metadata.reExport`) put where a consumer looks the instance up. */
export function declaredMetadata(tagMetadata: unknown, mark: boolean): Record<string, unknown> {
  const { reExport, ...own } = tagMetadata as Record<string, unknown> & {
    reExport?: { name: string; module: string; declaringModule: string; importPath?: readonly string[] };
  };
  const stamped: Record<string, unknown> = mark ? { ...own, xTeloChoice: true } : own;
  if (!reExport) return mark ? stamped : (tagMetadata as Record<string, unknown>);
  delete stamped.importPath;
  return {
    ...stamped,
    name: reExport.name,
    module: reExport.module,
    declaringModule: reExport.declaringModule,
    forwardedExport: true,
    ...(reExport.importPath ? { importPath: reExport.importPath } : {}),
  };
}
/** What a stand-in at a field or list position holds: an expression typed `dyn`. */
export const STAND_IN_SOURCE = "dyn(null)";

/** A declaration a choice nothing decides stands in for: its name, no kind.
 *  A reference to it resolves and is never judged by kind. */
export function isStandInDeclaration(manifest: unknown): boolean {
  const meta = (manifest as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  return meta?.[STAND_IN_MARK] === true;
}

export function isChoice(value: unknown): boolean {
  const tag = expansionTagOf(value);
  return tag === "if" || tag === "switch";
}

/** `a.b[0].c` → `["a", "b", 0, "c"]`. */
export function parsePath(path: string): (string | number)[] {
  const keys: (string | number)[] = [];
  const pattern = /([^.[\]]+)|\[(\d+)\]/g;
  for (const match of path.matchAll(pattern)) {
    if (match[2] !== undefined) keys.push(Number(match[2]));
    else keys.push(match[1]!);
  }
  return keys;
}

function startsWith(keys: Keys, prefix: Keys): boolean {
  return prefix.length <= keys.length && prefix.every((key, i) => keys[i] === key);
}

/** A path inside an expanded document, at its written place. Every mapping
 *  holds both places from the document's root, so the longest expanded prefix
 *  that applies says where the rest was written. */
export function relocatePath(path: string, mappings: readonly Mapping[]): string {
  const keys = parsePath(path);
  let match: Mapping | undefined;
  for (const mapping of mappings) {
    if (startsWith(keys, mapping.from) && (!match || mapping.from.length > match.from.length)) match = mapping;
  }
  if (!match) return path;
  if (match.exact) return pathOf(match.to);
  const rest = keys.slice(match.from.length);
  return pathOf(match.metadataAt && rest[0] === "metadata" ? [...match.metadataAt, ...rest] : [...match.to, ...rest]);
}
