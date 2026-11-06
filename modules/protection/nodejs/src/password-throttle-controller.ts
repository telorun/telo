import { createHash } from "node:crypto";
import {
  resolveInvocableDispatcher,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";

interface PasswordThrottleResource {
  metadata: { name: string };
  passwords: unknown;
  budget: unknown;
}

type Dispatch = (inputs: Record<string, unknown>, invokeCtx?: InvokeContext) => Promise<unknown>;

interface Reservation {
  allowed: boolean;
  reserved: number;
}

/**
 * Protection.PasswordThrottle — counts failures only. Every attempt reserves one
 * unit under the identifier's digest; a success settles it back to nothing, so
 * what stays spent is exactly the failed attempts of the window.
 */
class PasswordThrottle implements ResourceInstance {
  constructor(
    private readonly passwords: Dispatch,
    private readonly budget: Dispatch,
  ) {}

  async invoke(inputs: { identifier: string; password: string }, invokeCtx?: InvokeContext) {
    const key = createHash("sha256").update(inputs.identifier, "utf8").digest("hex");
    const reservation = (await this.budget({ op: "reserve", key, amount: 1 }, invokeCtx)) as Reservation;
    if (!reservation.allowed) return { refused: true as const, reason: "throttled" as const };

    const answer = (await this.passwords(inputs, invokeCtx)) as Record<string, unknown>;
    if ("principal" in answer) {
      await this.budget({ op: "settle", key, amount: 0, reserved: reservation.reserved }, invokeCtx);
    }
    return answer;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: PasswordThrottleResource, ctx: ResourceContext): Promise<PasswordThrottle> {
  const describe = `Protection.PasswordThrottle "${resource.metadata.name}"`;
  return new PasswordThrottle(
    resolveInvocableDispatcher(resource.passwords, ctx, () => `${describe}: 'passwords'`),
    resolveInvocableDispatcher(resource.budget, ctx, () => `${describe}: 'budget'`),
  );
}

export function register(): void {}
