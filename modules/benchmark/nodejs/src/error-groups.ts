import { truncate } from "./error-sample.js";

export const DEFAULT_MAX_GROUPS = 20;
export const MAX_MESSAGE_LENGTH = 300;
export const MAX_SAMPLE_LENGTH = 300;

const OVERFLOW_CODE = "OTHER";
const OVERFLOW_MESSAGE = "further distinct errors beyond the group limit";

export interface ErrorGroup {
  /** HTTP status or error code, as text. */
  code: string;
  message: string;
  count: number;
  /** First failure seen in the group, bounded. */
  sample: string;
}

/** The shared `errors` record of every report. */
export interface ErrorsRecord {
  count: number;
  rate: number;
  groups: ErrorGroup[];
}

/** Failures grouped by code and message. At most `maxGroups` groups plus one overflow group. */
export class ErrorGroups {
  private groups = new Map<string, ErrorGroup>();
  private overflow: ErrorGroup | undefined;

  constructor(private readonly maxGroups = DEFAULT_MAX_GROUPS) {}

  get count(): number {
    let n = this.overflow?.count ?? 0;
    for (const g of this.groups.values()) n += g.count;
    return n;
  }

  record(code: string, message: string, sample = "", times = 1): void {
    const bounded = {
      code: truncate(code, MAX_MESSAGE_LENGTH),
      message: truncate(message, MAX_MESSAGE_LENGTH),
      sample: truncate(sample, MAX_SAMPLE_LENGTH),
    };
    const key = `${bounded.code}\n${bounded.message}`;
    const existing = this.groups.get(key);
    if (existing) {
      existing.count += times;
    } else if (this.groups.size < this.maxGroups) {
      this.groups.set(key, { ...bounded, count: times });
    } else if (this.overflow) {
      this.overflow.count += times;
    } else {
      this.overflow = { code: OVERFLOW_CODE, message: OVERFLOW_MESSAGE, count: times, sample: bounded.sample };
    }
  }

  /** Groups by descending count, the overflow group last. */
  snapshot(): ErrorGroup[] {
    const groups = [...this.groups.values()].sort((a, b) => b.count - a.count).map((g) => ({ ...g }));
    if (this.overflow) groups.push({ ...this.overflow });
    return groups;
  }

  merge(other: ErrorGroups | ErrorGroup[]): void {
    const groups = other instanceof ErrorGroups ? other.snapshot() : other;
    for (const g of groups) this.record(g.code, g.message, g.sample, g.count);
  }

  /** `total` is the number of requests the failures are a share of. */
  toRecord(total: number): ErrorsRecord {
    const count = this.count;
    return { count, rate: total > 0 ? count / total : 0, groups: this.snapshot() };
  }
}
