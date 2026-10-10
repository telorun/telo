/**
 * A stream a write was handed and answers for until it exits. Pulled only
 * through here, so the write knows whether the stream ended — reached its end,
 * or failed on its own — and releases one that did not, at most once and whether
 * or not a chunk was ever pulled.
 */
export class HeldSource {
  private iterator: AsyncIterator<unknown> | undefined;
  private settled = false;

  constructor(private readonly source: AsyncIterable<unknown>) {}

  async next(): Promise<IteratorResult<unknown>> {
    this.iterator ??= this.source[Symbol.asyncIterator]();
    try {
      const pulled = await this.iterator.next();
      if (pulled.done) this.settled = true;
      return pulled;
    } catch (err) {
      this.settled = true;
      throw err;
    }
  }

  /** Nothing to do for a source that ended or was already released. */
  async release(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.iterator ??= this.source[Symbol.asyncIterator]();
    await this.iterator.return?.();
  }
}
