/**
 * Presence conditions: the set of configurations in which something holds,
 * written as a canonical multi-valued decision diagram over the dimensions, in
 * the one order the analysis reads them in.
 *
 * A node tests one dimension and has a child per value of its domain; a node
 * whose children are all one node is that node, and equal nodes are one node,
 * so two conditions holding in the same configurations are the same number.
 * `and`, `or` and `not` are memoized per space. Nothing here enumerates the
 * product of the dimensions: every operation walks the diagrams it is given.
 *
 * {@link ConditionSpace.cover} is the ONE description of a condition as a
 * union of product blocks (cubes) — what a label says and what a partial
 * assignment lists. It is deterministic: seeded at the first configuration the
 * condition holds in (dimension order, then value order), each block grown one
 * value at a time in that order while it stays inside the condition, and a
 * block every configuration of which later blocks cover is dropped.
 *
 * Browser-safe.
 */

/** A dimension as a condition reads it: a key and its ordered domain. */
export interface ConditionDimension {
  readonly key: string;
  readonly values: readonly unknown[];
}

/** A condition: a node of its space. `FALSE` and `TRUE` are the terminals. */
export type Condition = number & { readonly __condition: true };

export const FALSE = 0 as Condition;
export const TRUE = 1 as Condition;

/** One product block of a cover: the values it holds per dimension, in the
 *  order they were grown, for every dimension it narrows — a dimension it holds
 *  whole is left out. */
export type ConditionBlock = ReadonlyMap<string, readonly unknown[]>;

/** One assignment of a value to dimensions, by key. */
type Assignment = Readonly<Record<string, unknown>>;

export class ConditionSpace {
  readonly dimensions: readonly ConditionDimension[];
  private readonly levelOf: number[] = [Infinity, Infinity];
  private readonly childrenOf: (readonly Condition[])[] = [[], []];
  private readonly unique = new Map<string, Condition>();
  private readonly andMemo = new Map<string, Condition>();
  private readonly orMemo = new Map<string, Condition>();
  private readonly notMemo = new Map<Condition, Condition>();
  private readonly indexByKey: Map<string, number>;

  constructor(dimensions: readonly ConditionDimension[]) {
    this.dimensions = dimensions;
    this.indexByKey = new Map(dimensions.map((d, i) => [d.key, i]));
    if (this.indexByKey.size !== dimensions.length) throw new Error("A condition space names a dimension twice.");
  }

  /** The level of `key` in the dimension order. */
  levelOfKey(key: string): number {
    const level = this.indexByKey.get(key);
    if (level === undefined) throw new Error(`'${key}' is no dimension of this condition space.`);
    return level;
  }

  /** The index of `value` in the domain of the dimension at `level`. */
  valueIndex(level: number, value: unknown): number {
    const values = this.dimensions[level]!.values;
    const index = values.indexOf(value);
    if (index >= 0) return index;
    const text = JSON.stringify(value);
    const found = values.findIndex((v) => JSON.stringify(v) === text);
    if (found < 0) {
      throw new Error(`${JSON.stringify(value)} is not a value of the dimension '${this.dimensions[level]!.key}'.`);
    }
    return found;
  }

  private node(level: number, children: readonly Condition[]): Condition {
    const first = children[0]!;
    if (children.every((c) => c === first)) return first;
    const key = `${level}:${children.join(",")}`;
    const known = this.unique.get(key);
    if (known !== undefined) return known;
    const id = this.levelOf.length as Condition;
    this.levelOf.push(level);
    this.childrenOf.push(children);
    this.unique.set(key, id);
    return id;
  }

  private child(condition: Condition, level: number, index: number): Condition {
    return this.levelOf[condition] === level ? this.childrenOf[condition]![index]! : condition;
  }

  /** The configurations in which the dimension `key` holds one of `values`. */
  literal(key: string, values: readonly unknown[]): Condition {
    const level = this.levelOfKey(key);
    const held = new Set(values.map((v) => this.valueIndex(level, v)));
    return this.node(
      level,
      this.dimensions[level]!.values.map((_, i) => (held.has(i) ? TRUE : FALSE)),
    );
  }

  /** The product block holding, per dimension it names, the listed values. */
  cube(block: ConditionBlock | Readonly<Record<string, readonly unknown[]>>): Condition {
    const entries = block instanceof Map ? [...block] : Object.entries(block);
    let out = TRUE;
    for (const [key, values] of [...entries].sort((a, b) => this.levelOfKey(b[0]) - this.levelOfKey(a[0]))) {
      out = this.and(this.literal(key, values as readonly unknown[]), out);
    }
    return out;
  }

  /** The configuration (or, for a partial assignment, every configuration
   *  agreeing with it) `assignment` names. */
  assignment(assignment: Assignment): Condition {
    return this.cube(Object.fromEntries(Object.entries(assignment).map(([key, value]) => [key, [value]])));
  }

  and(a: Condition, b: Condition): Condition {
    if (a === FALSE || b === FALSE) return FALSE;
    if (a === TRUE) return b;
    if (b === TRUE || a === b) return a;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const known = this.andMemo.get(key);
    if (known !== undefined) return known;
    const out = this.apply(a, b, (x, y) => this.and(x, y));
    this.andMemo.set(key, out);
    return out;
  }

  or(a: Condition, b: Condition): Condition {
    if (a === TRUE || b === TRUE) return TRUE;
    if (a === FALSE) return b;
    if (b === FALSE || a === b) return a;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const known = this.orMemo.get(key);
    if (known !== undefined) return known;
    const out = this.apply(a, b, (x, y) => this.or(x, y));
    this.orMemo.set(key, out);
    return out;
  }

  not(a: Condition): Condition {
    if (a === TRUE) return FALSE;
    if (a === FALSE) return TRUE;
    const known = this.notMemo.get(a);
    if (known !== undefined) return known;
    const out = this.node(
      this.levelOf[a]!,
      this.childrenOf[a]!.map((c) => this.not(c)),
    );
    this.notMemo.set(a, out);
    return out;
  }

  /** Every condition of `conditions` together. */
  every(conditions: Iterable<Condition>): Condition {
    let out = TRUE;
    for (const c of conditions) out = this.and(out, c);
    return out;
  }

  /** Any condition of `conditions`. */
  some(conditions: Iterable<Condition>): Condition {
    let out = FALSE;
    for (const c of conditions) out = this.or(out, c);
    return out;
  }

  /** True when every configuration `a` holds in, `b` holds in. */
  implies(a: Condition, b: Condition): boolean {
    return this.and(a, this.not(b)) === FALSE;
  }

  private apply(a: Condition, b: Condition, op: (x: Condition, y: Condition) => Condition): Condition {
    const level = Math.min(this.levelOf[a]!, this.levelOf[b]!);
    return this.node(
      level,
      this.dimensions[level]!.values.map((_, i) => op(this.child(a, level, i), this.child(b, level, i))),
    );
  }

  /** Whether `condition` holds in `assignment`, which assigns every dimension
   *  the condition tests. */
  holds(condition: Condition, assignment: Assignment): boolean {
    let at = condition;
    while (at !== TRUE && at !== FALSE) {
      const level = this.levelOf[at]!;
      const key = this.dimensions[level]!.key;
      if (!Object.hasOwn(assignment, key)) {
        throw new Error(`The condition reads '${key}', which the assignment does not name.`);
      }
      at = this.childrenOf[at]![this.valueIndex(level, assignment[key])]!;
    }
    return at === TRUE;
  }

  /** The first configuration `condition` holds in — dimension by dimension in
   *  order, each its first value that still satisfies it — or undefined. */
  firstAssignment(condition: Condition): Record<string, unknown> | undefined {
    if (condition === FALSE) return undefined;
    const out: Record<string, unknown> = {};
    let at = condition;
    for (let level = 0; level < this.dimensions.length; level++) {
      const dimension = this.dimensions[level]!;
      if (this.levelOf[at] !== level) {
        out[dimension.key] = dimension.values[0];
        continue;
      }
      const children = this.childrenOf[at]!;
      const index = children.findIndex((c) => c !== FALSE);
      out[dimension.key] = dimension.values[index];
      at = children[index]!;
    }
    return out;
  }

  /**
   * `condition` as the fewest product blocks this order finds, each inside
   * `condition` where `universe` holds (a configuration outside `universe` is
   * one no block need avoid), together covering every configuration of
   * `universe` it holds in. Empty when it holds in none.
   */
  cover(condition: Condition, universe: Condition = TRUE): ConditionBlock[] {
    const target = this.and(condition, universe);
    const outside = this.and(universe, this.not(condition));
    const grown: { values: Map<string, Set<unknown>>; cube: Condition }[] = [];
    let remaining = target;
    while (remaining !== FALSE) {
      const seed = this.firstAssignment(remaining)!;
      const values = new Map<string, Set<unknown>>(this.dimensions.map((d) => [d.key, new Set([seed[d.key]])]));
      for (const dimension of this.dimensions) {
        const held = values.get(dimension.key)!;
        for (const value of dimension.values) {
          if (held.has(value)) continue;
          held.add(value);
          if (this.and(this.cubeOf(values), outside) !== FALSE) held.delete(value);
        }
      }
      const cube = this.cubeOf(values);
      remaining = this.and(remaining, this.not(cube));
      grown.push({ values, cube });
    }
    // A block every configuration of which the others cover says nothing.
    const kept = grown.map(() => true);
    for (let i = 0; i < grown.length; i++) {
      const others = this.some(grown.filter((_, j) => j !== i && kept[j]).map((other) => other.cube));
      if (this.implies(this.and(grown[i]!.cube, target), others)) kept[i] = false;
    }
    return grown.filter((_, i) => kept[i]).map(({ values }) => {
      const out = new Map<string, unknown[]>();
      for (const dimension of this.dimensions) {
        const held = [...values.get(dimension.key)!];
        if (held.length !== dimension.values.length) out.set(dimension.key, held);
      }
      return out;
    });
  }

  private cubeOf(values: ReadonlyMap<string, ReadonlySet<unknown>>): Condition {
    let out = TRUE;
    for (let level = this.dimensions.length - 1; level >= 0; level--) {
      const dimension = this.dimensions[level]!;
      const held = values.get(dimension.key)!;
      if (held.size === dimension.values.length) continue;
      out = this.and(this.literal(dimension.key, [...held]), out);
    }
    return out;
  }
}
