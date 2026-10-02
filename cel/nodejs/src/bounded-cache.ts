/**
 * A bounded least-recently-used cache.
 *
 * Every in-process cache in this engine is bounded with a declared capacity: a compiled
 * expression, a compiled pattern and a call site's resolved overloads are all keyed on
 * text a request can influence, so an unbounded cache is a memory leak with an author's
 * input as its key. Eviction is least-recently-used, which a `Map` gives for free: its
 * iteration order is insertion order, so re-inserting a hit moves it to the end and the
 * first key is always the oldest untouched one.
 */

export class BoundedCache<Key, Value> {
  private readonly held = new Map<Key, Value>();

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("a bounded cache holds at least one entry");
    }
  }

  get(key: Key): Value | undefined {
    if (!this.held.has(key)) return undefined;
    const value = this.held.get(key)!;
    this.held.delete(key);
    this.held.set(key, value);
    return value;
  }

  set(key: Key, value: Value): void {
    this.held.delete(key);
    this.held.set(key, value);
    if (this.held.size > this.capacity) {
      this.held.delete(this.held.keys().next().value as Key);
    }
  }

  /** Forgets everything — what a registration does to an environment's compiled programs. */
  clear(): void {
    this.held.clear();
  }

  get size(): number {
    return this.held.size;
  }
}
