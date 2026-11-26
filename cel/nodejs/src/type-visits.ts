/**
 * How many types the whole-type walks have visited in this process — a count only the cost
 * gates read, so a walk that re-walks a shared part shows as work rather than as time.
 */

let visits = 0;

/** One visit of a type, or of a pair of types, by a whole-type walk. */
export function countTypeVisit(): void {
  visits += 1;
}

/** Every visit counted so far; a gate reads the difference across the work it measures. */
export function typeVisits(): number {
  return visits;
}
