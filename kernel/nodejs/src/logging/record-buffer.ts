import type { LogRecord } from "@telorun/sdk";
import type { SinkBufferPolicy } from "./log-sink.js";

/**
 * The bounded buffer every asynchronous sink composes — `kernel/specs/logging.md`
 * §10.3.
 *
 * The ecosystems disagree by default: Rust's `tracing-appender` drops, zap
 * buffers 256 kB / 30 s, and pino has no bound at all. Telo therefore makes the
 * policy explicit and required, and the buffer is never unbounded.
 *
 * `drop_old` has no precedent among the surveyed libraries, so it is implemented
 * as specified — true ring-buffer semantics, evicting the oldest record — rather
 * than by analogy to something else.
 */
export class RecordBuffer {
  readonly #capacity: number;
  readonly #policy: SinkBufferPolicy;
  readonly #onDrop: () => void;
  #items: LogRecord[] = [];
  /** Index of the oldest record, so `drop_old` evicts in O(1) instead of
   *  shifting the whole array on every overflow. */
  #head = 0;

  constructor(policy: SinkBufferPolicy, onDrop: () => void) {
    this.#capacity = Math.max(1, policy.buffer);
    this.#policy = policy;
    this.#onDrop = onDrop;
  }

  get size(): number {
    return this.#items.length - this.#head;
  }

  get isFull(): boolean {
    return this.size >= this.#capacity;
  }

  push(record: LogRecord): void {
    if (this.isFull) {
      if (this.#policy.onFull === "drop_old") {
        this.#head += 1;
        this.#compact();
      } else {
        // `drop_new` — and `block`, which never reaches here because a runtime
        // that cannot honour it rejects the manifest at load rather than
        // silently degrading to a dropping policy.
        this.#onDrop();
        return;
      }
      this.#onDrop();
    }
    this.#items.push(record);
  }

  /** Take everything buffered, leaving the buffer empty. */
  drain(): LogRecord[] {
    const drained = this.#head === 0 ? this.#items : this.#items.slice(this.#head);
    this.#items = [];
    this.#head = 0;
    return drained;
  }

  #compact(): void {
    // Reclaim the consumed prefix once it dominates the array, so a long-lived
    // ring does not grow its backing store without bound.
    if (this.#head > 32 && this.#head * 2 >= this.#items.length) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
  }
}
