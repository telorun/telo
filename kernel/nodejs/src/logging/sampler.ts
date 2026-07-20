import { isErrorSeverity, type LogRecord } from "@telorun/sdk";

/**
 * Sampling — `kernel/specs/logging.md` §15. Off by default.
 *
 * The dedup key is (`severity_number`, `message`) rather than the attributes,
 * which is what keeps it cheap: a repeated message throttles regardless of the
 * per-occurrence data hanging off it.
 *
 * §15 permits a fixed-size counter table that accepts collisions, trading
 * precision for speed. This implementation instead keeps an
 * **insertion-ordered map bounded by an entry cap**, evicting the least recently
 * created key on overflow. Memory stays bounded either way, but a collision can
 * only ever *lose* a record that should have been emitted, and no throughput
 * gain justified that.
 */

export interface SamplingConfig {
  /** Records emitted unconditionally at the start of each window. */
  first: number;
  /** Thereafter every Nth record is emitted. `0` drops everything after the
   *  first `first` in the window. */
  thereafter: number;
  /** Window length in milliseconds. */
  tickMs: number;
  /** Records at ERROR and above are not sampled by default (§15). */
  sampleErrors?: boolean;
}

const MAX_TRACKED_KEYS = 4096;

interface Window {
  start: number;
  count: number;
}

export class Sampler {
  readonly #config: SamplingConfig;
  readonly #windows = new Map<string, Window>();

  constructor(config: SamplingConfig) {
    this.#config = config;
  }

  /** `true` when the record should be emitted, `false` when it is sampled out.
   *  A `false` result is counted under cause `sampled` by the caller. */
  shouldEmit(record: LogRecord, now: number): boolean {
    if (!this.#config.sampleErrors && isErrorSeverity(record.severityNumber)) return true;

    const key = `${record.severityNumber}\x00${record.message}`;
    let window = this.#windows.get(key);

    if (!window || now - window.start >= this.#config.tickMs) {
      window = { start: now, count: 0 };
      this.#windows.delete(key);
      this.#windows.set(key, window);
      this.#evictOverflow();
    }

    window.count += 1;

    if (window.count <= this.#config.first) return true;
    if (this.#config.thereafter <= 0) return false;

    const sinceFirst = window.count - this.#config.first;
    return sinceFirst % this.#config.thereafter === 0;
  }

  #evictOverflow(): void {
    while (this.#windows.size > MAX_TRACKED_KEYS) {
      const oldest = this.#windows.keys().next();
      if (oldest.done) return;
      this.#windows.delete(oldest.value);
    }
  }
}
