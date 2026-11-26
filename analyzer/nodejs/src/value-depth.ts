/**
 * How deeply a value nests, and the limit a validation holds it to.
 *
 * Every array and plain object is one level (`{}` is 1, `{ a: {} }` is 2); an
 * instance value and anything else is a leaf. A validation refuses to run over a
 * value nested past `maxValueDepth` (`analyzer/validation-limits.json`, shared by
 * every runtime), so where a deep value is refused does not depend on the stack of
 * the engine validating it. The walk keeps its own stack and visits each node once.
 *
 * Browser-safe. Twin: `analyzer/rust/src/value_depth.rs`.
 */

import { CEL_VALUE_TYPE } from "@telorun/cel";
import LIMITS from "./validation-limits.json" with { type: "json" };

/** The deepest a value may nest and still be validated. */
export const MAX_VALUE_DEPTH: number = LIMITS.maxValueDepth;

function isLevel(value: unknown): value is object {
  if (Array.isArray(value)) return true;
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return (value as { [CEL_VALUE_TYPE]?: unknown })[CEL_VALUE_TYPE] === undefined;
}

/** The places of a value that hold values validated on their own — each a path
 *  of keys (an array index as its number or its text) from the value's root. */
export type OwnValuePositions = readonly (readonly (string | number)[])[];

/** A trie of {@link OwnValuePositions}: `true` marks a position. */
type PositionTrie = Map<string, PositionTrie | true>;

function positionTrie(positions: OwnValuePositions): PositionTrie | undefined {
  if (positions.length === 0) return undefined;
  const root: PositionTrie = new Map();
  for (const keys of positions) {
    if (keys.length === 0) continue;
    let at = root;
    for (const [index, key] of keys.entries()) {
      const text = String(key);
      if (index === keys.length - 1) {
        at.set(text, true);
        break;
      }
      const next = at.get(text);
      if (next === true) break;
      if (next) at = next;
      else at.set(text, (at = new Map()));
    }
  }
  return root;
}

/** Whether `value` nests deeper than {@link MAX_VALUE_DEPTH}, counted from its
 *  root, each value at one of `ownValues` counted as one leaf: that value is
 *  validated, and its depth judged, on its own. */
export function nestsPastValueDepth(value: unknown, ownValues: OwnValuePositions = []): boolean {
  if (!isLevel(value)) return false;
  const pending: [object, number, PositionTrie | undefined][] = [[value, 1, positionTrie(ownValues)]];
  while (pending.length > 0) {
    const [node, depth, positions] = pending.pop()!;
    if (depth > MAX_VALUE_DEPTH) return true;
    const keys = Array.isArray(node) ? Array.from({ length: node.length }, (_, index) => String(index)) : Object.keys(node);
    for (const key of keys) {
      const item = (node as Record<string, unknown>)[key];
      if (!isLevel(item)) continue;
      const below = positions?.get(key);
      if (below === true) continue;
      pending.push([item, depth + 1, below]);
    }
  }
  return false;
}
