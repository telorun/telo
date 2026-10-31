import { canonicalSource } from "./condition-atoms.js";

/**
 * The rule that decides which loop may index a family: the one reader behind
 * `REF_MEMBER_INVALID`'s "iterates the family's own source at that depth" and
 * the editor's completion of the bindings inside `!ref <family>[`.
 *
 * A loop is seen as its binding, its source expression as written, and the
 * loops it sits in (outermost first). Depth 0 compares sources after every
 * binding root is replaced by its own loop's source, canonicalized over the
 * parsed tree; a deeper loop must iterate the reference's own previous binding,
 * along the path the family's loop at that depth reads.
 *
 * Browser-safe.
 */
export interface LoopView {
  /** The name the loop binds (`each` when it writes no `as:`). */
  readonly binding: string;
  /** The CEL text of its `in:`; undefined when it is no expression. */
  readonly source: string | undefined;
  /** The loops it sits in, outermost first. */
  readonly enclosing: readonly LoopView[];
}

/** A loop's source, every binding root replaced by its own loop's source. */
export function canonicalLoopSource(loop: LoopView, seen = new Set<LoopView>()): string | undefined {
  if (seen.has(loop)) return undefined;
  seen.add(loop);
  const canonical = loop.source !== undefined ? canonicalSource(loop.source) : undefined;
  if (canonical === undefined) return undefined;
  const [root, ...rest] = canonical.split(".");
  if (root === "self") return canonical;
  const outer = [...loop.enclosing].reverse().find((r) => r.binding === root);
  const base = outer ? canonicalLoopSource(outer, seen) : undefined;
  return base === undefined ? undefined : `(${base}).${rest.join(".")}`;
}

/** Whether `loop`, indexing at `depth` of a reference, iterates the same source
 *  as `familyLoop`, the family's loop at that depth. `previous` is the loop the
 *  reference's index at the depth before bound (unused at depth 0). */
export function iteratesFamilySource(
  depth: number,
  loop: LoopView,
  previous: LoopView | undefined,
  familyLoop: LoopView,
): boolean {
  if (depth === 0) {
    const own = canonicalLoopSource(loop);
    return own !== undefined && own === canonicalLoopSource(familyLoop);
  }
  const own = loop.source?.trim().split(".");
  const family = familyLoop.source?.trim().split(".");
  if (!own || !family || !previous) return false;
  const root = [...loop.enclosing].reverse().find((r) => r.binding === own[0]);
  return root === previous && own.slice(1).join(".") === family.slice(1).join(".");
}
