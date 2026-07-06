import {
  type ControllerContext,
  type ResourceContext,
  type ResourceInstance,
  parseDurationMs,
} from "@telorun/sdk";
import { type CacheStore, resolveCacheStore } from "@telorun/cache";

interface BudgetResource {
  metadata: { name: string; module?: string };
  store?: CacheStore | { name: string; alias?: string };
  limit: number;
  window: string;
}

interface BudgetInputs {
  op: "reserve" | "settle";
  key: string;
  amount: number;
  reserved?: number;
}

interface BudgetResult {
  allowed?: boolean;
  remaining?: number;
  retryAfter?: number;
  reserved?: number;
  total?: number;
  settled?: boolean;
}

/**
 * A windowed, weighted spend budget over a Cache.Store. Two-phase so the counter
 * can't be gamed:
 *  - `reserve` atomically debits a worst-case `amount` against the window; if
 *    that pushes the total over `limit` it refunds and denies, so concurrent
 *    first-calls can't all slip under the ceiling (the atomic increment closes
 *    the burst race) and a reserve-then-abandon still pays (charge-on-start).
 *  - `settle` adjusts the reservation to the actual cost (delta = actual −
 *    reserved), refunding the unused remainder — or keeping the full reservation
 *    when a caller reports actual == reserved (errored / cancelled with no usage).
 * Non-throwing on the limit path: returns a verdict the caller maps (e.g. 429).
 */
class RateLimitBudget implements ResourceInstance<BudgetInputs, BudgetResult> {
  private readonly windowMs: number;

  constructor(
    private readonly resource: BudgetResource,
    private readonly ctx: ResourceContext,
  ) {
    this.windowMs = parseDurationMs(resource.window);
  }

  async invoke(inputs: BudgetInputs): Promise<BudgetResult> {
    // Fail closed: an empty key must not collapse every caller into one bucket.
    if (!inputs || typeof inputs.key !== "string" || inputs.key.length === 0) {
      return { allowed: false, remaining: 0, retryAfter: Math.ceil(this.windowMs / 1000), reserved: 0 };
    }
    if (!Number.isInteger(inputs.amount) || inputs.amount < 0) {
      throw new Error("RateLimit.Budget: 'amount' input is required and must be a non-negative integer");
    }
    const store = resolveCacheStore(this.resource.store, this.ctx);
    const bucketKey = `budget:${this.resource.metadata.name}:${inputs.key}`;

    if (inputs.op === "settle") {
      if (!Number.isInteger(inputs.reserved) || (inputs.reserved as number) < 0) {
        throw new Error("RateLimit.Budget: 'settle' requires the non-negative integer 'reserved' returned by the matching reserve");
      }
      const delta = inputs.amount - (inputs.reserved as number);
      if (delta === 0) return { settled: true, total: await this.currentTotal(store, bucketKey) };
      let total = await store.increment(bucketKey, delta, this.windowMs);
      if (total < 0) {
        // The reserve's window rolled over before this settle, so the refund
        // seeded a fresh counter negative — which would grant phantom budget
        // next window. Compensate back to a non-negative floor.
        total = await store.increment(bucketKey, -total, this.windowMs);
      }
      return { settled: true, total };
    }

    if (inputs.op === "reserve") {
      const total = await store.increment(bucketKey, inputs.amount, this.windowMs);
      if (total > this.resource.limit) {
        // Refund the over-ceiling reservation so an unrelated caller isn't
        // charged for this denial, and deny.
        await store.increment(bucketKey, -inputs.amount, this.windowMs);
        return { allowed: false, remaining: 0, retryAfter: Math.ceil(this.windowMs / 1000), reserved: 0 };
      }
      return { allowed: true, remaining: this.resource.limit - total, retryAfter: 0, reserved: inputs.amount };
    }

    throw new Error(`RateLimit.Budget: unknown op '${String(inputs.op)}'; expected 'reserve' or 'settle'`);
  }

  /** Read the window total without moving it (a no-op settle still reports it). */
  private async currentTotal(store: CacheStore, key: string): Promise<number> {
    return store.increment(key, 0, this.windowMs);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: BudgetResource,
  ctx: ResourceContext,
): Promise<RateLimitBudget> {
  return new RateLimitBudget(resource, ctx);
}
