/**
 * What the create-time reference edges tell us about a set of resources.
 *
 * The edges themselves are captured by `collectResourceRefs` and projected onto
 * local names by `localDependencyNames` (both in `evaluation-context.ts`, beside
 * the init loop that records them). This module is the two questions asked of
 * that record afterwards, and they are the same question read in opposite
 * directions:
 *
 *  - **Forward**, for teardown: in what order may these unwind, so that a
 *    consumer's inverses run while what it holds is still alive.
 *  - **Reverse**, for reconciliation: if these resources are about to become
 *    invalid, who else is holding one and therefore becomes invalid too.
 *
 * Both read `Map<consumer, provider names>` and neither knows what a resource
 * is, which is what keeps them testable without a kernel.
 */

/** A resource's outgoing edges: the local names it holds. */
export type DependencyMap = ReadonlyMap<string, readonly string[]>;

/**
 * Order resources so that a consumer is torn down before everything it holds.
 *
 * The caller's order is the TIEBREAK, not the rule. Reverse insertion is
 * already a valid reverse-topological order for every edge Phase-5 injection
 * resolves, because the init loop defers a resource whose refs are unresolved
 * (`ERR_LOCAL_REF_PENDING`) and so cannot insert a consumer before its
 * provider. What this adds is the edges that never pass through injection — a
 * controller resolving a sibling by name inside `init()` — where insertion
 * order says nothing.
 *
 * A cycle emits the first unordered entry and continues: teardown must always
 * run to completion, so an unorderable set degrades to the caller's order
 * rather than raising.
 */
export function reverseTopologicalOrder<T>(
  entries: ReadonlyArray<readonly [string, T]>,
  nameOf: (value: T) => string,
  dependenciesOf: (name: string) => readonly string[] | undefined,
): Array<readonly [string, T]> {
  const indexByName = new Map<string, number>();
  entries.forEach(([, value], index) => indexByName.set(nameOf(value), index));

  // One edge per (consumer, provider): the provider waits for the consumer.
  const providersOf: number[][] = entries.map(() => []);
  const waiting: number[] = entries.map(() => 0);
  entries.forEach(([, value], consumer) => {
    for (const dependency of dependenciesOf(nameOf(value)) ?? []) {
      const provider = indexByName.get(dependency);
      if (provider === undefined || provider === consumer) continue;
      providersOf[consumer]!.push(provider);
      waiting[provider]! += 1;
    }
  });

  const ordered: Array<readonly [string, T]> = [];
  const emitted: boolean[] = entries.map(() => false);
  for (let count = 0; count < entries.length; count++) {
    let pick = entries.findIndex((_, i) => !emitted[i] && waiting[i] === 0);
    if (pick < 0) pick = entries.findIndex((_, i) => !emitted[i]);
    emitted[pick] = true;
    ordered.push(entries[pick]!);
    for (const provider of providersOf[pick]!) waiting[provider]! -= 1;
  }
  return ordered;
}

/**
 * Every resource that becomes invalid when `seeds` do: the seeds themselves, and
 * everything that transitively HOLDS one of them.
 *
 * A holder has to go with what it holds because it is holding the instance
 * itself — Phase-5 injection wrote a live object into its reference slot, and
 * rebuilding the target leaves the holder pointing at an object nothing will
 * ever call again. There is no version of this where the holder keeps running,
 * which is why replacing one resource restarts everything above it. That is a
 * cost to state rather than a defect to fix: editing a connection's declaration
 * restarts what uses it.
 *
 * **Exact over the DECLARED edge set, and only that.** An edge exists here when
 * a reference slot named the target, or when a CEL expression read it. A
 * controller that resolves a sibling by NAME instead has a real dependency no
 * walk of the manifest can see; those resolutions are recorded separately as
 * they happen (`opaquelyRead`), and a caller whose closure reaches one has to
 * escalate rather than trust this answer.
 *
 * A cycle is not a special case: the walk visits each name once.
 */
export function impactClosure(seeds: Iterable<string>, dependencies: DependencyMap): Set<string> {
  // Reversed once per call rather than maintained: the map moves on every
  // create, this is asked once per reconciliation, and an index kept in step
  // with a mutating map is a second source of truth.
  const holdersOf = new Map<string, string[]>();
  for (const [consumer, providers] of dependencies) {
    for (const provider of providers) {
      const held = holdersOf.get(provider);
      if (held) held.push(consumer);
      else holdersOf.set(provider, [consumer]);
    }
  }

  const impacted = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (impacted.has(name)) continue;
    impacted.add(name);
    for (const holder of holdersOf.get(name) ?? []) {
      if (!impacted.has(holder)) queue.push(holder);
    }
  }
  return impacted;
}
