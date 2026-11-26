/**
 * The `$ref` each canonicalized schema node was written with — what a
 * reference finding quotes and judges once canonicalization rewrote it.
 *
 * Browser-safe.
 */

const authoredRefs = new WeakMap<object, string>();

/** `node` was written with `ref`; a node already recorded keeps its first. */
export function recordAuthoredSchemaRef(node: object, ref: string): void {
  if (!authoredRefs.has(node)) authoredRefs.set(node, ref);
}

/** The `$ref` `node` was written with, where canonicalization rewrote it. */
export function authoredSchemaRef(node: object): string | undefined {
  return authoredRefs.get(node);
}

/** `copy` keeps the `$ref` `node` was written with. */
export function carryAuthoredSchemaRef(node: object, copy: object): void {
  const authored = authoredRefs.get(node);
  if (authored !== undefined) authoredRefs.set(copy, authored);
}
