/**
 * Where a document holds values Telo validates ON THEIR OWN — the positions a
 * whole-document validation counts as one leaf each when it measures how deeply
 * the document nests (`value-depth.ts`), since only the validation owning a
 * value judges its depth. Each position is read off the reader that owns that
 * validation: the reference-slot reach (the value at a slot, and the argument map
 * its `inputs:` pointer names), the step grammar (a step's argument map), and the
 * module documents' input entries (an entry's `default:`, each value an import
 * supplies). Browser-safe; the kernel reads it at creation.
 */

import { slotInputsPath, stepItemsOf } from "./derived-slots.js";
import type { ReachSite } from "./reference-reach.js";
import { parseKeys } from "./template-expansion.js";
import type { OwnValuePositions } from "./value-depth.js";

const INPUT_BLOCKS = ["variables", "secrets"] as const;

const isMap = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The keys of every entry of `block` of `holder`, prefixed by `at`. */
function entryPositions(holder: Record<string, unknown>, at: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const block of INPUT_BLOCKS) {
    const entries = holder[block];
    if (!isMap(entries)) continue;
    for (const key of Object.keys(entries)) out.push([...at, block, key]);
  }
  return out;
}

/** The input values a module document or an import declaration holds: each
 *  `variables:` / `secrets:` entry's `default:` of an Application or Library,
 *  and each value an import supplies — in an `imports:` entry's object form or
 *  on a `Telo.Import`. */
export function moduleInputValuePositions(document: Record<string, unknown>): OwnValuePositions {
  if (document.kind === "Telo.Import") return entryPositions(document, []);
  if (document.kind !== "Telo.Application" && document.kind !== "Telo.Library") return [];
  const out: string[][] = [];
  for (const block of INPUT_BLOCKS) {
    const entries = document[block];
    if (!isMap(entries)) continue;
    for (const [key, entry] of Object.entries(entries)) {
      if (isMap(entry) && entry.default !== undefined) out.push([block, key, "default"]);
    }
  }
  const imports = document.imports;
  if (isMap(imports)) {
    for (const [alias, entry] of Object.entries(imports)) {
      if (isMap(entry)) out.push(...entryPositions(entry, ["imports", alias]));
    }
  }
  return out;
}

/** Every value of `document`, a declaration of a kind whose schema is
 *  `kindSchema`, validated on its own: its module inputs, the value at each of
 *  its reference slots (`sites`, its reach) and the argument map each slot and
 *  each step call names. */
export function ownValuePositions(
  document: Record<string, unknown>,
  kindSchema: Record<string, any>,
  sites: readonly ReachSite[],
): OwnValuePositions {
  const out: (readonly (string | number)[])[] = [...moduleInputValuePositions(document)];
  for (const site of sites) {
    if (site.refs.length === 0) continue;
    if (site.keys.length > 0) out.push(site.keys);
    const inputs = slotInputsPath(site);
    if (inputs !== undefined) out.push(parseKeys(inputs));
  }
  for (const item of stepItemsOf(document, kindSchema)) out.push([...parseKeys(item.path), item.inputsField]);
  return out;
}
