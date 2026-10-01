import { diffArrays } from "diff";

import { bodyLines, itemBlocks } from "@/plan/item-grammar";

export type DiffRow =
  | { kind: "same"; text: string; baseLine: number; targetLine: number }
  | { kind: "removed"; text: string; baseLine: number }
  | { kind: "added"; text: string; targetLine: number };

/** A line diff of two revision bodies; line numbers are 1-based. */
export function lineDiff(base: string, target: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let baseLine = 1;
  let targetLine = 1;
  for (const change of diffArrays(bodyLines(base), bodyLines(target))) {
    for (const text of change.value) {
      if (change.added) rows.push({ kind: "added", text, targetLine: targetLine++ });
      else if (change.removed) rows.push({ kind: "removed", text, baseLine: baseLine++ });
      else rows.push({ kind: "same", text, baseLine: baseLine++, targetLine: targetLine++ });
    }
  }
  return rows;
}

export interface ItemSummary {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Item IDs the target adds, removes, or declares with different text. Each
 *  list follows the order the IDs appear in (target first, then base). */
export function itemSummary(base: string, target: string): ItemSummary {
  const before = itemBlocks(base);
  const after = itemBlocks(target);
  const summary: ItemSummary = { added: [], removed: [], changed: [] };
  for (const [id, text] of after) {
    const previous = before.get(id);
    if (previous === undefined) summary.added.push(id);
    else if (previous !== text) summary.changed.push(id);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) summary.removed.push(id);
  }
  return summary;
}
