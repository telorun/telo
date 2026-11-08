/**
 * One cycle of request indices in which each request appears `weight` times, spread evenly
 * (smooth weighted round-robin), so every subject and every pass sends the same mix.
 */
export function weightedCycle(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  const current = weights.map(() => 0);
  const cycle: number[] = [];
  for (let step = 0; step < total; step++) {
    let best = 0;
    for (let i = 0; i < weights.length; i++) {
      current[i] += weights[i];
      if (current[i] > current[best]) best = i;
    }
    current[best] -= total;
    cycle.push(best);
  }
  return cycle;
}

/** Splits `total` into `parts` integers differing by at most one, larger first. */
export function evenShares(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const shares: number[] = [];
  for (let i = 0; i < parts; i++) shares.push(base + (i < total % parts ? 1 : 0));
  return shares;
}
