import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundSessionOperation, type OperationResource } from "./session-operation.js";
import type { RotateInput } from "./sessions-controller.js";

/** Session.Rotate — replaces a session by a fresh one, e.g. after a change of privileges. */
class Rotate implements ResourceInstance<RotateInput, Record<string, unknown>> {
  constructor(private readonly bound: BoundSessionOperation) {}

  async invoke(inputs: RotateInput): Promise<Record<string, unknown>> {
    return { ...(await this.bound.sessions.rotate(inputs)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<Rotate> {
  return new Rotate(new BoundSessionOperation("Session.Rotate", resource, ctx));
}

export function register(): void {}
