import { celMapFromEntries, isCelMap, type IndexKey } from "@telorun/sdk";

/** Where a family's member stands: the family's name and the keys of its loops,
 *  outermost first. */
export interface FamilyPlace {
  readonly family: string;
  readonly keys: readonly IndexKey[];
}

type Level = Record<string, unknown>;

/**
 * The CEL `resources` record of one template instance: the defining module's
 * readings with the body's own entries layered over them at read time.
 *
 * Entries publish into an instance-own map, so a member's update costs one
 * write whatever the family's size, and two instances never share a map. A
 * family's members are gathered under the family's name as a map by element
 * key — `string` keys a plain object, `int` keys a CEL map — one level per loop;
 * a member's identity text is never a name here. Read as the module-level
 * record is read: a published reading is replaced wholesale, so what a read
 * returns is the latest publication.
 */
export class TemplateBodyResources {
  private readonly local: Level = Object.create(null);
  private places: ReadonlyMap<string, FamilyPlace> = new Map();
  /** Bumped whenever a name is written at the record's top level, which is all a
   *  cached merge depends on beside its base: a family member's update lands
   *  inside a map already held. */
  private shape = 0;
  private cache: { base: unknown; shape: number; merged: Level } | undefined;
  private readonly produced = new WeakSet<object>();
  private override: unknown;
  private overridden = false;

  /** The members of every family the instance's body declared, by identity. */
  declareFamilies(places: ReadonlyMap<string, FamilyPlace>): void {
    this.places = places;
  }

  /** The identities of the members of the family `family`. */
  membersOf(family: string): string[] {
    return [...this.places].filter(([, place]) => place.family === family).map(([name]) => name);
  }

  publish(name: string, reading: Record<string, unknown>): void {
    const place = this.places.get(name);
    if (!place) {
      this.local[name] = reading;
      this.shape++;
      return;
    }
    let level: Level | undefined = this.local[place.family] as Level | undefined;
    if (level === undefined) {
      level = this.newLevel(place.keys[0]!);
      this.local[place.family] = level;
      this.shape++;
    }
    for (let depth = 0; depth < place.keys.length - 1; depth++) {
      let next = this.read(level, place.keys[depth]!) as Level | undefined;
      if (next === undefined) {
        next = this.newLevel(place.keys[depth + 1]!);
        this.write(level, place.keys[depth]!, next);
      }
      level = next;
    }
    this.write(level, place.keys[place.keys.length - 1]!, reading);
  }

  /** The record a read sees: `base` with the body's entries over it. */
  merged(base: unknown): Level {
    const cached = this.cache;
    if (cached && cached.base === base && cached.shape === this.shape) return cached.merged;
    const merged: Level = { ...((base as Level | undefined) ?? {}), ...this.local };
    this.produced.add(merged);
    this.cache = { base, shape: this.shape, merged };
    return merged;
  }

  /**
   * The `resources` property of the instance's CEL context, as one accessor.
   * A site that binds its own `resources` (a scope run inside the body) assigns
   * it for the length of an evaluation and restores what it read: restoring a
   * record this property produced lifts the assignment, so the property stays
   * live.
   */
  descriptor(base: () => unknown): PropertyDescriptor {
    return {
      enumerable: true,
      configurable: true,
      get: () => (this.overridden ? this.override : this.merged(base())),
      set: (value: unknown) => {
        if (typeof value === "object" && value !== null && this.produced.has(value)) {
          this.overridden = false;
          this.override = undefined;
          return;
        }
        this.overridden = true;
        this.override = value;
      },
    };
  }

  private newLevel(key: IndexKey): Level {
    return typeof key === "string" ? Object.create(null) : (celMapFromEntries([]) as unknown as Level);
  }

  private read(level: Level, key: IndexKey): unknown {
    if (isCelMap(level)) {
      return (level.entries as ReadonlyMap<bigint, { value: unknown }>).get(BigInt(key as number))?.value;
    }
    return level[key as string];
  }

  private write(level: Level, key: IndexKey, value: unknown): void {
    if (isCelMap(level)) {
      const k = BigInt(key as number);
      (level.entries as Map<bigint, { key: bigint; value: unknown }>).set(k, { key: k, value });
      return;
    }
    level[key as string] = value;
  }
}
