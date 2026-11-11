import {
  durationNanos,
  isCelDuration,
  NEVER_CANCELLED,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import type { OfferOutcome, RendezvousPoint, TakeOutcome } from "./rendezvous-point-contract.js";

/** The longest delay a Node timer holds; a longer wait re-arms until its deadline. */
const MAX_TIMER_MS = 2_147_483_647;
const NANOS_PER_MILLISECOND = 1_000_000n;

interface MemoryPointResource {
  metadata: { name: string; module?: string };
  /** Omitted means `DEFAULT_HOLD_MS`: a schema default of a duration is not decoded. */
  hold?: unknown;
}

interface Waiter {
  settle(outcome: TakeOutcome): void;
}

interface Held {
  payload: unknown;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_HOLD_MS = 60_000;

function holdMilliseconds(resource: MemoryPointResource): number {
  if (resource.hold === undefined || resource.hold === null) return DEFAULT_HOLD_MS;
  if (!isCelDuration(resource.hold)) {
    throw new Error(`Rendezvous.MemoryPoint "${resource.metadata.name}": 'hold' must be a duration`);
  }
  // Fractional: a sub-millisecond hold keeps its real deadline.
  return Number(durationNanos(resource.hold)) / Number(NANOS_PER_MILLISECOND);
}

/**
 * Rendezvous.MemoryPoint — waiters and held values in this resource's own
 * memory. Every operation runs to completion without an `await`, so an offer and
 * a take on one key cannot interleave. A key never has a waiter and a held value
 * at once: an offer meeting a waiter hands over, and a take finding a held value
 * takes it.
 */
class MemoryPoint implements RendezvousPoint, ResourceInstance {
  private readonly waiters = new Map<string, Waiter>();
  private readonly held = new Map<string, Held>();
  private readonly holdMs: number;

  constructor(resource: MemoryPointResource) {
    this.holdMs = holdMilliseconds(resource);
  }

  init(ctx: ResourceContext) {
    return ctx.effect("pending waiters and held values", async () => ({
      result: undefined,
      inverse: () => {
        for (const waiter of [...this.waiters.values()]) waiter.settle({ outcome: "cancelled" });
        for (const entry of this.held.values()) clearTimeout(entry.timer);
        this.held.clear();
      },
    }));
  }

  async take(key: string, timeoutMs: number, invokeCtx?: InvokeContext): Promise<TakeOutcome> {
    const cancellation = invokeCtx?.cancellation ?? NEVER_CANCELLED;
    if (cancellation.isCancelled) return { outcome: "cancelled" };
    if (this.waiters.has(key)) return { outcome: "busy" };
    const held = this.held.get(key);
    if (held) {
      clearTimeout(held.timer);
      this.held.delete(key);
      return { outcome: "taken", payload: held.payload };
    }
    if (timeoutMs <= 0) return { outcome: "timedOut" };

    return new Promise<TakeOutcome>((resolve) => {
      const deadline = Date.now() + timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      let settled = false;
      const arm = () => {
        timer = setTimeout(() => {
          if (Date.now() >= deadline) waiter.settle({ outcome: "timedOut" });
          else arm();
        }, Math.min(deadline - Date.now(), MAX_TIMER_MS));
      };
      const waiter: Waiter = {
        settle: (outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          this.waiters.delete(key);
          resolve(outcome);
        },
      };
      this.waiters.set(key, waiter);
      arm();
      unsubscribe = cancellation.onCancelled(() => waiter.settle({ outcome: "cancelled" }));
    });
  }

  async offer(key: string, payload: unknown): Promise<OfferOutcome> {
    const waiter = this.waiters.get(key);
    if (waiter) {
      waiter.settle({ outcome: "taken", payload });
      return { outcome: "delivered" };
    }
    const previous = this.held.get(key);
    if (previous) clearTimeout(previous.timer);
    const entry: Held = { payload, deadline: Date.now() + this.holdMs, timer: undefined };
    this.held.set(key, entry);
    this.armExpiry(key, entry);
    return { outcome: "held" };
  }

  /** Expires `entry` at its deadline, re-arming in segments a Node timer can hold. */
  private armExpiry(key: string, entry: Held): void {
    const remaining = entry.deadline - Date.now();
    const timer = setTimeout(
      () => {
        if (this.held.get(key) !== entry) return;
        if (Date.now() >= entry.deadline) this.held.delete(key);
        else this.armExpiry(key, entry);
      },
      Math.min(Math.max(Math.ceil(remaining), 1), MAX_TIMER_MS),
    );
    // A held value must not keep the process alive on its own.
    timer.unref?.();
    entry.timer = timer;
  }

  async provide(): Promise<MemoryPoint> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: MemoryPointResource): Promise<MemoryPoint> {
  return new MemoryPoint(resource);
}
