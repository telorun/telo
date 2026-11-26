/**
 * Every scoped `Telo.Import` a module's declarations write — in an
 * `x-telo-scope` field of a declaration, or of a member of one, at any depth —
 * by the module declaring its holder, then by its alias, in written order, each
 * with where it is present: its holder's declaration condition and the
 * condition of every option on the way to it (FALSE inside a branch no
 * configuration takes, which a forcing decides). Read off where it is written,
 * never off the loader's stamps, which a member written under a choice lacks.
 * Built once per analysis; a one-configuration set is read with every member
 * present.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { holdingOf, isAlternatives, meet, type ChoiceStep, type Holding } from "./conditioned-expansion.js";
import { isKindDocument } from "./kind-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import type { ConditionSpace, Condition } from "./presence-condition.js";
import type { ScopedImportPlace } from "./scoped-import-identity.js";
import { isScopeMemberDeclaration } from "./scope-members.js";

/** One scoped `Telo.Import`, where it is written and where it is present. */
export interface ScopedImportEntry {
  readonly place: ScopedImportPlace;
  readonly holding: Holding;
  /** The document it is written in, and its keys there. */
  readonly written: { readonly root: ResourceManifest; readonly keys: readonly (string | number)[] };
  /** The declaration holding it, and its keys in that declaration's manifest,
   *  every option on the way skipped. */
  readonly declaration: IndexedDeclaration;
  readonly unionKeys: readonly (string | number)[];
  /** The member as the declaration holds it. */
  readonly member: Readonly<Record<string, unknown>>;
}

/** By declaring module, then alias, in written order. */
export type ScopedImportIndex = ReadonlyMap<string, ReadonlyMap<string, readonly ScopedImportEntry[]>>;

/** A declaration the index reads, with where it is declared — and the
 *  document it is written in and its keys there, absent for one written as a
 *  document of its own. */
export interface IndexedDeclaration {
  readonly manifest: ResourceManifest;
  readonly condition: Condition;
  readonly path: readonly ChoiceStep[];
  readonly holder?: ResourceManifest;
  readonly at?: readonly (string | number)[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** The scoped imports `declarations` write; `scopeFieldsOf` names a holder's
 *  scope fields, its kind read in the module `metadata.module` names. */
export function scopedImportIndex(
  declarations: readonly IndexedDeclaration[],
  scopeFieldsOf: (holder: ResourceManifest) => readonly string[],
  space: ConditionSpace | undefined,
): ScopedImportIndex {
  const out = new Map<string, Map<string, ScopedImportEntry[]>>();
  for (const declaration of declarations) {
    const m = declaration.manifest;
    if (typeof m.kind !== "string" || m.kind === "Telo.Import" || isModuleKind(m.kind) || isKindDocument(m)) continue;
    // A scope member the analysis holds beside its holder is read through it.
    if (isScopeMemberDeclaration(m)) continue;
    const module = (m.metadata as { module?: unknown } | undefined)?.module;
    const byAlias = new Map<string, ScopedImportEntry[]>();
    const root = declaration.holder ?? m;
    type Keys = readonly (string | number)[];
    const item = (value: unknown, holder: string, field: string, holding: Holding, keys: Keys, unionKeys: Keys): void => {
      if (isAlternatives(value)) {
        for (const option of value.options) {
          if (option.present) item(option.value, holder, field, meet(space, holding, holdingOf(option)), option.moved ? option.at : keys, unionKeys);
        }
        return;
      }
      if (!isRecord(value) || typeof value.kind !== "string") return;
      const name = (value.metadata as { name?: unknown } | undefined)?.name;
      if (typeof name !== "string") return;
      if (value.kind === "Telo.Import") {
        const list = byAlias.get(name) ?? [];
        byAlias.set(name, list);
        list.push({ place: { alias: name, holder, field }, holding, written: { root, keys }, declaration, unionKeys, member: value });
        return;
      }
      if (isModuleKind(value.kind) || isKindDocument(value)) return;
      visit({ ...value, metadata: { ...(value.metadata as object), module } } as unknown as ResourceManifest, name, holding, keys, unionKeys);
    };
    const list = (value: unknown, holder: string, field: string, holding: Holding, keys: Keys, unionKeys: Keys): void => {
      if (isAlternatives(value)) {
        for (const option of value.options) {
          if (option.present) list(option.value, holder, field, meet(space, holding, holdingOf(option)), option.moved ? option.at : keys, unionKeys);
        }
        return;
      }
      if (Array.isArray(value)) value.forEach((entry, i) => item(entry, holder, field, holding, [...keys, i], [...unionKeys, i]));
    };
    const visit = (holder: ResourceManifest, name: string, holding: Holding, keys: Keys, unionKeys: Keys): void => {
      for (const field of scopeFieldsOf(holder)) {
        list((holder as unknown as Record<string, unknown>)[field], name, field, holding, [...keys, field], [...unionKeys, field]);
      }
    };
    const name = m.metadata?.name;
    if (typeof name !== "string") continue;
    visit(m, name, { condition: declaration.condition, path: declaration.path }, declaration.at ?? [], []);
    if (byAlias.size === 0) continue;
    const key = typeof module === "string" ? module : "";
    const known = out.get(key) ?? new Map<string, ScopedImportEntry[]>();
    out.set(key, known);
    for (const [alias, entries] of byAlias) known.set(alias, [...(known.get(alias) ?? []), ...entries]);
  }
  return out;
}

/** What a kind's alias names among a module's scoped imports: the one import —
 *  or, where which is present varies, the alias, decided where a finding about
 *  it is emitted ({@link scopedImportParts}). */
export type ScopedImportReading =
  | { readonly place: ScopedImportPlace }
  | { readonly module: string; readonly alias: string };
