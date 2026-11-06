import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundSessionOperation, type OperationResource } from "./session-operation.js";
import type { StartInput } from "./sessions-controller.js";

/** Session.Start — begins a session under a fresh id and hands back its token once. */
class Start implements ResourceInstance<StartInput, Record<string, unknown>> {
  constructor(private readonly bound: BoundSessionOperation) {}

  async invoke(inputs: StartInput): Promise<Record<string, unknown>> {
    return { ...(await this.bound.sessions.start(inputs)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<Start> {
  return new Start(new BoundSessionOperation("Session.Start", resource, ctx));
}

export function register(): void {}
