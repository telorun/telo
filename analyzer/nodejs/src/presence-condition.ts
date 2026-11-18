/**
 * Presence conditions: the set of configurations in which something holds,
 * written as a canonical multi-valued decision diagram over the dimensions, in
 * the one order the analysis reads them in.
 *
 * A node tests one dimension and has a child per value of its domain; a node
 * whose children are all one node is that node, and equal nodes are one node,
 * so two conditions holding in the same configurations are the same number.
 * `and`, `or` and `not` are memoized per space; `restrict`, `exists` and
 * `translate` (into another space) rebuild a diagram node by node, memoized per
 * call. Nothing here enumerates the product of the dimensions: every operation
 * walks the diagrams it is given.
 *
 * {@link ConditionSpace.cover} is the ONE description of a condition as a
 * union of product blocks (cubes) — what a label says and what a partial
 * assignment lists. It is deterministic: seeded at the first configuration the
 * condition holds in (dimension order, then value order), each block grown one
 * value at a time in that order while it stays inside the condition, and a
 * block every configuration of which later blocks cover is dropped.
 *
 * A dimension is a CONFIGURATION dimension (an input, a need) or a DEFINITION
 * dimension — one of a template definition's own closed reads, atoms or
 * selectors, keyed by the definition's identity and its local key
 * ({@link definitionDimensionKey}). A configuration names every configuration
 * dimension and no definition one, so a universe built from configurations
 * leaves definition dimensions free; a witness names a definition dimension
 * only where its condition tests it, so its size is its support, whatever the
 * space holds.
 *
 * Browser-safe.
 */

/** What a definition dimension stands for in its definition's body. A module
 *  input a body choice reads is no definition dimension: it is the
 *  configuration's own. */
export type DefinitionRole = "closed" | "atom" | "selector";

/** Which template definition a dimension belongs to, its role there and its
 *  key in that definition's own reading. */
export interface DefinitionDimension {
  readonly identity: string;
  readonly role: DefinitionRole;
  readonly key: string;
}

/** A dimension as a condition reads it: a key and its ordered domain, and —
 *  for a definition dimension — the definition it belongs to. */
export interface ConditionDimension {
  readonly key: string;
  readonly values: readonly unknown[];
  readonly definition?: DefinitionDimension;
}

/** The space key of the dimension `key` of the definition `identity`. An
 *  identity holds no `:`, and no configuration key does. */
export function definitionDimensionKey(identity: string, key: string): string {
  return `${identity}:${key}`;
}

/** A condition: a node of its space. `FALSE` and `TRUE` are the terminals. */
export type Condition = number & { readonly __condition: true };

export const FALSE = 0 as Condition;
export const TRUE = 1 as Condition;

/** One product block of a cover: the values it holds per dimension, in the
 *  order they were grown, for every dimension it narrows — a dimension it holds
 *  whole is left out. */
export type ConditionBlock = ReadonlyMap<string, readonly unknown[]>;

/** What {@link ConditionSpace.translate} reads a dimension as in its target:
 *  a condition per value of its domain, a dimension of the target, or a fixed
 *  value. */
export type TranslationMeaning =
  | { readonly values: readonly Condition[] }
  | { readonly key: string }
  | { readonly fact: unknown };

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
  /** The levels of the configuration dimensions, in order. */
  private readonly configurationLevels: number[];
  private readonly definitionLevel: boolean[];
  private steps = 0;

  constructor(dimensions: readonly ConditionDimension[]) {
    this.dimensions = dimensions;
    this.indexByKey = new Map(dimensions.map((d, i) => [d.key, i]));
    if (this.indexByKey.size !== dimensions.length) throw new Error("A condition space names a dimension twice.");
    this.definitionLevel = dimensions.map((d) => d.definition !== undefined);
    this.configurationLevels = dimensions.flatMap((d, i) => (d.definition ? [] : [i]));
  }

  /** The steps this space's operations have taken, for measuring their cost. */
  get work(): number {
    return this.steps;
  }

  /** The definition dimension `key` names, or undefined for a configuration
   *  dimension or a key of no dimension. */
  definitionOf(key: string): DefinitionDimension | undefined {
    const level = this.indexByKey.get(key);
    return level === undefined ? undefined : this.dimensions[level]!.definition;
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
    this.steps++;
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
      this.steps++;
      out = this.and(this.literal(key, values as readonly unknown[]), out);
    }
    return out;
  }

  /** The configuration (or, for a partial assignment, every configuration
   *  agreeing with it) `assignment` names: every dimension it leaves out —
   *  each definition dimension a configuration leaves out — is free. */
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

  /** The classes `conditions` split the space into — each non-empty
   *  intersection of every condition or its complement — in the order the
   *  splits make them. As many as the conditions are independent. */
  atoms(conditions: Iterable<Condition>): Condition[] {
    let out: Condition[] = [TRUE];
    for (const c of new Set(conditions)) {
      if (c === TRUE || c === FALSE) continue;
      out = out.flatMap((atom) => [this.and(atom, c), this.and(atom, this.not(c))].filter((x) => x !== FALSE));
    }
    return out;
  }

  /** True when every configuration `a` holds in, `b` holds in. */
  implies(a: Condition, b: Condition): boolean {
    return this.and(a, this.not(b)) === FALSE;
  }

  /** `condition` with each dimension `assignment` names fixed to its value:
   *  what it says where those hold, no longer reading them. */
  restrict(condition: Condition, assignment: Assignment): Condition {
    const fixed = new Map<number, number>();
    for (const [key, value] of Object.entries(assignment)) {
      const level = this.levelOfKey(key);
      fixed.set(level, this.valueIndex(level, value));
    }
    return this.rewrite(condition, (level, children) => {
      const index = fixed.get(level);
      return index === undefined ? undefined : children[index]!;
    });
  }

  /** `condition` holding wherever some value of each dimension in `keys` makes
   *  it hold: those dimensions projected out. */
  exists(condition: Condition, keys: Iterable<string>): Condition {
    const levels = new Set([...keys].map((key) => this.levelOfKey(key)));
    return this.rewrite(condition, (level, children) => (levels.has(level) ? this.some(children) : undefined));
  }

  /** {@link exists} over every definition dimension: where some way of
   *  deciding the definitions makes `condition` hold. */
  existsDefinitions(condition: Condition): Condition {
    return this.rewrite(condition, (level, children) => (this.definitionLevel[level] ? this.some(children) : undefined));
  }

  /** {@link exists} over every configuration dimension. */
  existsConfiguration(condition: Condition): Condition {
    return this.rewrite(condition, (level, children) => (this.definitionLevel[level] ? undefined : this.some(children)));
  }

  /**
   * `condition` carried into `target`: each dimension of this space read by
   * `meaningOf` as a condition of `target` per value of its domain
   * (`{ values }`, the functional composition of the dimension with them), a
   * dimension of `target` (`{ key }`, its values equal where both domains hold
   * them), a fixed value (`{ fact }`), or nothing — projected out. The last
   * three are `values` too: a value's literal of the other dimension, TRUE at
   * the fact alone, TRUE at every value. A value with no equal in the other
   * domain is one no configuration there agrees with.
   */
  translate(
    condition: Condition,
    target: ConditionSpace,
    meaningOf: (key: string) => TranslationMeaning | undefined,
  ): Condition {
    const vectors = new Map<number, readonly Condition[]>();
    const vectorAt = (level: number): readonly Condition[] => {
      const known = vectors.get(level);
      if (known) return known;
      const values = this.dimensions[level]!.values;
      const meaning = meaningOf(this.dimensions[level]!.key);
      let vector: readonly Condition[];
      if (meaning === undefined) vector = values.map(() => TRUE);
      else if ("values" in meaning) {
        if (meaning.values.length !== values.length) {
          throw new Error(`internal: a translation gives the dimension '${this.dimensions[level]!.key}' ${meaning.values.length} values of ${values.length}.`);
        }
        vector = meaning.values;
      } else if ("fact" in meaning) {
        const index = values.indexOf(meaning.fact);
        vector = values.map((_, i) => (i === index ? TRUE : FALSE));
      } else {
        const domain = target.dimensions[target.levelOfKey(meaning.key)]!.values;
        vector = values.map((value) => (domain.includes(value) ? target.literal(meaning.key, [value]) : FALSE));
      }
      vectors.set(level, vector);
      return vector;
    };
    const memo = new Map<Condition, Condition>();
    const carry = (at: Condition): Condition => {
      if (at === TRUE || at === FALSE) return at;
      const known = memo.get(at);
      if (known !== undefined) return known;
      this.steps++;
      const vector = vectorAt(this.levelOf[at]!);
      const children = this.childrenOf[at]!;
      const out = target.some(children.flatMap((child, i) => (vector[i] === FALSE ? [] : [target.and(vector[i]!, carry(child))])));
      memo.set(at, out);
      return out;
    };
    return carry(condition);
  }

  /** Whether `condition` tests a definition dimension. */
  readsDefinition(condition: Condition): boolean {
    for (const level of this.levelsTested([condition])) if (this.definitionLevel[level]) return true;
    return false;
  }

  /** `condition` rebuilt node by node, `replace` answering for a node of a
   *  level it handles from its rebuilt children. */
  private rewrite(
    condition: Condition,
    replace: (level: number, children: readonly Condition[]) => Condition | undefined,
  ): Condition {
    const memo = new Map<Condition, Condition>();
    const visit = (at: Condition): Condition => {
      if (at === TRUE || at === FALSE) return at;
      const known = memo.get(at);
      if (known !== undefined) return known;
      this.steps++;
      const level = this.levelOf[at]!;
      const children = this.childrenOf[at]!.map(visit);
      const out = replace(level, children) ?? this.node(level, children);
      memo.set(at, out);
      return out;
    };
    return visit(condition);
  }

  private apply(a: Condition, b: Condition, op: (x: Condition, y: Condition) => Condition): Condition {
    this.steps++;
    const level = Math.min(this.levelOf[a]!, this.levelOf[b]!);
    return this.node(
      level,
      this.dimensions[level]!.values.map((_, i) => op(this.child(a, level, i), this.child(b, level, i))),
    );
  }

  /** Whether `condition` holds in `assignment`, which assigns every
   *  configuration dimension the condition tests; a definition dimension it
   *  leaves out is at its first value, as {@link firstAssignment} leaves it. */
  holds(condition: Condition, assignment: Assignment): boolean {
    let at = condition;
    while (at !== TRUE && at !== FALSE) {
      this.steps++;
      const level = this.levelOf[at]!;
      const key = this.dimensions[level]!.key;
      if (!Object.hasOwn(assignment, key)) {
        if (!this.definitionLevel[level]) {
          throw new Error(`The condition reads '${key}', which the assignment does not name.`);
        }
        at = this.childrenOf[at]![0]!;
        continue;
      }
      at = this.childrenOf[at]![this.valueIndex(level, assignment[key])]!;
    }
    return at === TRUE;
  }

  /** The first configuration `condition` holds in — dimension by dimension in
   *  order, each its first value that still satisfies it — or undefined. It
   *  names every configuration dimension and each definition dimension the
   *  condition tests on the way; one it leaves out is at its first value. */
  firstAssignment(condition: Condition): Record<string, unknown> | undefined {
    if (condition === FALSE) return undefined;
    const out: Record<string, unknown> = {};
    const configuration = this.configurationLevels;
    let next = 0;
    const firstUpTo = (level: number) => {
      for (; next < configuration.length && configuration[next]! < level; next++) {
        this.steps++;
        const dimension = this.dimensions[configuration[next]!]!;
        out[dimension.key] = dimension.values[0];
      }
    };
    let at = condition;
    while (at !== TRUE) {
      this.steps++;
      const level = this.levelOf[at]!;
      firstUpTo(level);
      if (configuration[next] === level) next++;
      const children = this.childrenOf[at]!;
      const index = children.findIndex((c) => c !== FALSE);
      out[this.dimensions[level]!.key] = this.dimensions[level]!.values[index];
      at = children[index]!;
    }
    firstUpTo(Infinity);
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
    // A dimension neither tests is grown whole whatever the rest holds, so
    // only the ones they test are grown, in order.
    const levels = [...this.levelsTested([target, outside])].sort((a, b) => a - b);
    const grown: { values: Map<number, Set<unknown>>; cube: Condition }[] = [];
    let remaining = target;
    while (remaining !== FALSE) {
      const values = this.seedOf(remaining, levels);
      for (const level of levels) {
        const held = values.get(level)!;
        for (const value of this.dimensions[level]!.values) {
          if (held.has(value)) continue;
          held.add(value);
          if (this.and(this.cubeOf(values, levels), outside) !== FALSE) held.delete(value);
        }
      }
      const cube = this.cubeOf(values, levels);
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
      for (const level of levels) {
        const dimension = this.dimensions[level]!;
        const held = [...values.get(level)!];
        if (held.length !== dimension.values.length) out.set(dimension.key, held);
      }
      return out;
    });
  }

  /** The levels any of `conditions` tests. */
  private levelsTested(conditions: readonly Condition[]): Set<number> {
    const out = new Set<number>();
    const seen = new Set<Condition>();
    const visit = (at: Condition) => {
      if (at === TRUE || at === FALSE || seen.has(at)) return;
      seen.add(at);
      this.steps++;
      out.add(this.levelOf[at]!);
      for (const child of this.childrenOf[at]!) visit(child);
    };
    for (const condition of conditions) visit(condition);
    return out;
  }

  /** {@link firstAssignment} of `condition` at `levels` (every level it
   *  tests among them), each value as the one set a cover grows. */
  private seedOf(condition: Condition, levels: readonly number[]): Map<number, Set<unknown>> {
    const out = new Map<number, Set<unknown>>();
    let at = condition;
    for (const level of levels) {
      const values = this.dimensions[level]!.values;
      if (this.levelOf[at] !== level) {
        out.set(level, new Set([values[0]]));
        continue;
      }
      const index = this.childrenOf[at]!.findIndex((c) => c !== FALSE);
      out.set(level, new Set([values[index]]));
      at = this.childrenOf[at]![index]!;
    }
    return out;
  }

  private cubeOf(values: ReadonlyMap<number, ReadonlySet<unknown>>, levels: readonly number[]): Condition {
    let out = TRUE;
    for (let i = levels.length - 1; i >= 0; i--) {
      const level = levels[i]!;
      const dimension = this.dimensions[level]!;
      const held = values.get(level)!;
      if (held.size === dimension.values.length) continue;
      out = this.and(this.literal(dimension.key, [...held]), out);
    }
    return out;
  }
}
