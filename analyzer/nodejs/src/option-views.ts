/**
 * Every option of every expansion construct a document writes, as declarations
 * a pass can read: a few copies of the document, each taking one branch of each
 * `!if` / `!switch` it reaches and emitting each `!for-each`'s item as written,
 * which together take every branch the document writes — a branch no
 * configuration takes, and each branch of a choice inside one, included. A
 * document's views number at most its branches, whatever its choices' product.
 *
 * Each view carries the relocation of {@link expandChoices}: where each of its
 * positions is written (`steps[0].invoke.then`, `with[1]` for an item after a
 * branch that is absent in the view). A construct `sites` does not hold, or
 * holds refused, is left as written.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import { expansionTagOf, isExpansionSentinel, isTaggedSentinel, SPLICE_KEY, type ExpansionSentinel } from "@telorun/templating";
import { branchKeys, branchValue, declaresNoResource } from "./choice-reading.js";
import { withBranchStamps } from "./chosen-scoped-import.js";
import type { PlaceMapping } from "./conditioned-expansion.js";
import type { ExpansionPosition, ExpansionSite } from "./expansion-sites.js";

type Keys = readonly (string | number)[];

/** A plain mapping or list, the only containers a view rebuilds. */
function isContainer(value: unknown): value is object {
  if (!value || typeof value !== "object" || isTaggedSentinel(value) || isCompiledValue(value)) return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** One view of a written document. */
export interface OptionView {
  /** The document as written. */
  readonly written: ResourceManifest;
  /** The document with one branch of each construct taken; for a whole
   *  document behind a tag, the declaration its branch makes. */
  readonly manifest: ResourceManifest;
  /** Where each position of {@link manifest} is written in {@link written}. */
  readonly mappings: readonly PlaceMapping[];
}

const DECLARATION_POSITIONS: ReadonlySet<ExpansionPosition> = new Set(["document", "template-resource", "scope-member"]);

/** The branch ids a choice writes, in written order. */
function branchesOf(sentinel: ExpansionSentinel): string[] {
  const body = sentinel as Record<string, unknown>;
  if (expansionTagOf(sentinel) === "if") return ["then", "else"].filter((branch) => Object.hasOwn(body, branch));
  const cases = body.cases;
  return [
    ...(cases && typeof cases === "object" && !Array.isArray(cases) ? Object.keys(cases).map((key) => `case:${key}`) : []),
    ...(Object.hasOwn(body, "default") ? ["default"] : []),
  ];
}

/** The views of `document` taking, between them, every branch it writes. */
export function optionViews(document: ResourceManifest, sites: ReadonlyMap<object, ExpansionSite>): OptionView[] {
  const taken = new Map<ExpansionSentinel, Set<string>>();
  const active = (value: unknown): ExpansionSite | undefined => {
    if (!isExpansionSentinel(value)) return undefined;
    const site = sites.get(value);
    return site && site.refusal === undefined ? site : undefined;
  };
  const isChoice = (sentinel: ExpansionSentinel) => {
    const tag = expansionTagOf(sentinel);
    return tag === "if" || tag === "switch";
  };

  /** Whether a branch beneath `value` no view has taken yet. */
  const pending = (value: unknown, memo: WeakMap<object, boolean>): boolean => {
    if (!isContainer(value)) return false;
    const known = memo.get(value);
    if (known !== undefined) return known;
    memo.set(value, false);
    let found: boolean;
    if (isExpansionSentinel(value)) {
      if (!active(value)) found = false;
      else if (isChoice(value)) {
        const seen = taken.get(value);
        found = branchesOf(value).some((branch) => !seen?.has(branch) || pending(branchValue(value, branch).value, memo));
      } else found = pending((value as Record<string, unknown>).emit, memo);
    } else {
      found = Object.values(value).some((child) => pending(child, memo));
    }
    memo.set(value, found);
    return found;
  };

  const views: OptionView[] = [];
  for (let first = true; first || pending(document, new WeakMap()); first = false) {
    const memo = new WeakMap<object, boolean>();
    let progressed = false;
    const choose = (sentinel: ExpansionSentinel): string | undefined => {
      const branches = branchesOf(sentinel);
      const seen = taken.get(sentinel) ?? new Set<string>();
      taken.set(sentinel, seen);
      const branch =
        branches.find((b) => !seen.has(b)) ??
        branches.find((b) => pending(branchValue(sentinel, b).value, memo)) ??
        branches[0];
      if (branch !== undefined && !seen.has(branch)) {
        seen.add(branch);
        progressed = true;
      }
      return branch;
    };
    const mappings: PlaceMapping[] = [];

    const expandTag = (
      sentinel: ExpansionSentinel,
      site: ExpansionSite,
      from: Keys,
      to: Keys,
      named: { value: unknown; at: Keys } | undefined,
    ): { present: boolean; value?: unknown } => {
      const ownMetadata = (sentinel as Record<string, unknown>).metadata;
      const tagNamed = ownMetadata !== undefined ? { value: ownMetadata, at: from } : named;
      let chosen: unknown;
      let at: Keys;
      if (isChoice(sentinel)) {
        const branch = choose(sentinel);
        if (branch === undefined) return { present: false };
        chosen = branchValue(sentinel, branch).value;
        at = [...from, ...branchKeys(branch)];
        const inner = active(chosen);
        if (inner && isChoice(chosen as ExpansionSentinel)) return expandTag(chosen as ExpansionSentinel, inner, at, to, tagNamed);
      } else {
        chosen = (sentinel as Record<string, unknown>).emit;
        at = [...from, "emit"];
      }
      if (DECLARATION_POSITIONS.has(site.position)) {
        if (!chosen || typeof chosen !== "object" || Array.isArray(chosen) || declaresNoResource(chosen, site.position === "scope-member")) return { present: false };
        mappings.push({ from: to, to: at, ...(tagNamed ? { metadataAt: tagNamed.at } : {}) });
        const { kind, ...fields } = chosen as Record<string, unknown>;
        const declared: Record<string, unknown> = { kind, metadata: withBranchStamps((tagNamed?.value ?? {}) as Record<string, unknown>, chosen) };
        for (const [key, field] of Object.entries(fields)) {
          if (key === "metadata") continue;
          const r = expandValue(field, [...at, key], [...to, key]);
          if (r.present) declared[key] = r.value;
        }
        return { present: true, value: declared };
      }
      mappings.push({ from: to, to: at });
      return expandValue(chosen, at, to);
    };

    const expandValue = (value: unknown, from: Keys, to: Keys): { present: boolean; value?: unknown } => {
      const site = active(value);
      if (site) return expandTag(value as ExpansionSentinel, site, from, to, undefined);
      if (!isContainer(value) || isExpansionSentinel(value)) return { present: true, value };
      if (Array.isArray(value)) {
        const items: unknown[] = [];
        value.forEach((item, i) => {
          const repeat = active(item);
          const emit = (item as Record<string, unknown> | null)?.emit;
          if (repeat && !isChoice(item as ExpansionSentinel) && Array.isArray(emit) && !DECLARATION_POSITIONS.has(repeat.position)) {
            emit.forEach((each, k) => {
              const at = [...from, i, "emit", k];
              const r = expandValue(each, at, [...to, items.length]);
              if (!r.present) return;
              mappings.push({ from: [...to, items.length], to: at });
              items.push(r.value);
            });
            return;
          }
          const r = expandValue(item, [...from, i], [...to, items.length]);
          if (!r.present) return;
          if (items.length !== i) mappings.push({ from: [...to, items.length], to: [...from, i] });
          items.push(r.value);
        });
        return { present: true, value: items };
      }
      const record: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value)) {
        if (key === SPLICE_KEY) {
          const repeats = Array.isArray(field) ? field : [field];
          if (repeats.every((repeat) => active(repeat) !== undefined)) {
            repeats.forEach((repeat, j) => {
              const at = Array.isArray(field) ? [...from, key, j, "emit"] : [...from, key, "emit"];
              const emit = (repeat as Record<string, unknown>).emit;
              if (!emit || typeof emit !== "object" || Array.isArray(emit)) return;
              for (const [entry, each] of Object.entries(emit)) {
                const r = expandValue(each, [...at, entry], [...to, entry]);
                if (!r.present) continue;
                mappings.push({ from: [...to, entry], to: [...at, entry] });
                record[entry] = r.value;
              }
            });
            continue;
          }
        }
        const r = expandValue(field, [...from, key], [...to, key]);
        if (r.present) record[key] = r.value;
      }
      return { present: true, value: record };
    };

    const r = expandValue(document, [], []);
    if (!first && !progressed) break;
    if (r.present) views.push({ written: document, manifest: r.value as ResourceManifest, mappings });
  }
  return views;
}
