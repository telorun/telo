/** A figure measured over several samples: the median, with its spread beside it. */
export interface Spread {
  median: number;
  min: number;
  max: number;
  /** Sample standard deviation over the mean; 0 for one sample or a zero mean. */
  cv: number;
}

export function spread(values: number[]): Spread {
  if (values.length === 0) throw new RangeError("spread needs at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  let cv = 0;
  if (sorted.length > 1 && mean !== 0) {
    const variance = sorted.reduce((a, v) => a + (v - mean) ** 2, 0) / (sorted.length - 1);
    cv = Math.sqrt(variance) / Math.abs(mean);
  }
  return { median, min: sorted[0], max: sorted[sorted.length - 1], cv };
}
