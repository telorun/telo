/** The most a tunnel moves at once before its byte rate holds it back. */
const BURST_BYTES = 64 * 1024;

/**
 * A token bucket over one direction of a tunnel: bytes taken beyond the
 * allowance are a debt the caller waits out before taking more. Nothing is
 * refused; a transfer is only held to the rate.
 */
export class ByteRate {
  private readonly burst: number;
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly bytesPerSecond: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.burst = Math.min(bytesPerSecond, BURST_BYTES);
    this.tokens = this.burst;
    this.updatedAt = now();
  }

  /** Takes `bytes`; answers how long, in milliseconds, before the next take. */
  take(bytes: number): number {
    const at = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((at - this.updatedAt) * this.bytesPerSecond) / 1000);
    this.updatedAt = at;
    this.tokens -= bytes;
    return this.tokens >= 0 ? 0 : (-this.tokens * 1000) / this.bytesPerSecond;
  }
}
