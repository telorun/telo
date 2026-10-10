/**
 * What the front end refuses to read because it is too big.
 *
 * An expression arrives from a manifest, from an editor buffer or over a wire, so
 * the parser is a hostile-input boundary: without a bound, nesting alone exhausts
 * the call stack of a recursive-descent parser, a long chain builds a tree no
 * recursive walker can finish, and a generated list exhausts memory. Each limit is
 * reported as an ordinary ranged diagnostic — never a thrown error — so an editor
 * keeps the prefix it could read.
 *
 * The defaults are the ones every already-written manifest was accepted under.
 */

export interface CelParseLimits {
  /** Nodes in the tree. */
  readonly maxNodes: number;
  /**
   * Nesting: how deep the grammar descends, and how tall the tree is — a node with no
   * child is 1 high, any other one more than its tallest child. So a chain
   * (`1 + 1 + …`, `a.b.b…`) counts as its bracketed form does.
   */
  readonly maxDepth: number;
  /** Elements in one list literal. */
  readonly maxListElements: number;
  /** Entries in one map literal. */
  readonly maxMapEntries: number;
  /** Arguments at one call. */
  readonly maxCallArguments: number;
}

export const DEFAULT_PARSE_LIMITS: CelParseLimits = {
  maxNodes: 100000,
  maxDepth: 250,
  maxListElements: 1000,
  maxMapEntries: 1000,
  maxCallArguments: 32,
};

export function resolveParseLimits(limits?: Partial<CelParseLimits>): CelParseLimits {
  return limits ? { ...DEFAULT_PARSE_LIMITS, ...limits } : DEFAULT_PARSE_LIMITS;
}
