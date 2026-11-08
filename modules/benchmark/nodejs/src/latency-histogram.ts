// Log-linear histogram (HDR-style) in microseconds. Memory is fixed by the value range, not by
// the sample count, and two histograms merge by adding bucket counts.

const PRECISION_BITS = 7;
const SUB_BUCKETS = 1 << PRECISION_BITS; // 128
const LINEAR_LIMIT = SUB_BUCKETS * 2; // values below this are stored exactly
const MAX_EXPONENT = 36;
const MAX_VALUE_US = 2 ** (MAX_EXPONENT + 1) - 1; // about 19 hours
const BUCKET_COUNT = (MAX_EXPONENT - PRECISION_BITS + 1) * SUB_BUCKETS + SUB_BUCKETS;

/** Worst-case relative error of a reported percentile, from bucketing alone. */
export const HISTOGRAM_RELATIVE_ERROR = 1 / (2 * SUB_BUCKETS);

/** The wire form of a histogram: plain data, safe to post between worker threads. */
export interface LatencyHistogramSnapshot {
  count: number;
  minUs: number;
  maxUs: number;
  sumUs: number;
  /** Non-empty buckets as `[index, count]` pairs. */
  buckets: Array<[number, number]>;
}

function exponentOf(value: number): number {
  const high = Math.floor(value / 4294967296);
  return high > 0 ? 63 - Math.clz32(high) : 31 - Math.clz32(value);
}

function indexOf(valueUs: number): number {
  if (valueUs < LINEAR_LIMIT) return valueUs;
  const shift = exponentOf(valueUs) - PRECISION_BITS;
  return shift * SUB_BUCKETS + Math.floor(valueUs / 2 ** shift);
}

function midpointOf(index: number): number {
  if (index < LINEAR_LIMIT) return index;
  const shift = Math.floor(index / SUB_BUCKETS) - 1;
  const quotient = index - shift * SUB_BUCKETS;
  return (quotient + 0.5) * 2 ** shift;
}

export class LatencyHistogram {
  private counts = new Float64Array(BUCKET_COUNT);
  private total = 0;
  private minUs = Infinity;
  private maxUs = 0;
  private sumUs = 0;

  get count(): number {
    return this.total;
  }

  /** Records one latency in milliseconds. Values past the range clamp to its top. */
  recordMs(ms: number): void {
    if (!(ms >= 0)) throw new RangeError(`Latency must be a non-negative number, got ${ms}`);
    const us = Math.min(Math.round(ms * 1000), MAX_VALUE_US);
    this.counts[indexOf(us)] += 1;
    this.total += 1;
    this.sumUs += us;
    if (us < this.minUs) this.minUs = us;
    if (us > this.maxUs) this.maxUs = us;
  }

  /** The latency in ms at fraction `p` (0.99 is p99); 0 when nothing was recorded. */
  percentileMs(p: number): number {
    if (this.total === 0) return 0;
    const rank = Math.max(1, Math.ceil(Math.min(Math.max(p, 0), 1) * this.total));
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      seen += this.counts[i];
      if (seen >= rank) {
        return Math.min(Math.max(midpointOf(i), this.minUs), this.maxUs) / 1000;
      }
    }
    return this.maxUs / 1000;
  }

  minMs(): number {
    return this.total === 0 ? 0 : this.minUs / 1000;
  }

  maxMs(): number {
    return this.maxUs / 1000;
  }

  meanMs(): number {
    return this.total === 0 ? 0 : this.sumUs / this.total / 1000;
  }

  merge(other: LatencyHistogram | LatencyHistogramSnapshot): void {
    const snap = other instanceof LatencyHistogram ? other.snapshot() : other;
    for (const [index, n] of snap.buckets) {
      if (!Number.isInteger(index) || index < 0 || index >= BUCKET_COUNT) {
        throw new RangeError(`Histogram bucket index ${index} is outside 0..${BUCKET_COUNT - 1}`);
      }
      this.counts[index] += n;
    }
    this.total += snap.count;
    this.sumUs += snap.sumUs;
    if (snap.count > 0) {
      if (snap.minUs < this.minUs) this.minUs = snap.minUs;
      if (snap.maxUs > this.maxUs) this.maxUs = snap.maxUs;
    }
  }

  snapshot(): LatencyHistogramSnapshot {
    const buckets: Array<[number, number]> = [];
    for (let i = 0; i < this.counts.length; i++) {
      if (this.counts[i] > 0) buckets.push([i, this.counts[i]]);
    }
    return {
      count: this.total,
      minUs: this.total === 0 ? 0 : this.minUs,
      maxUs: this.maxUs,
      sumUs: this.sumUs,
      buckets,
    };
  }

  static from(snapshot: LatencyHistogramSnapshot): LatencyHistogram {
    const histogram = new LatencyHistogram();
    histogram.merge(snapshot);
    return histogram;
  }
}
