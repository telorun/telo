import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundSessionOperation, type OperationResource } from "./session-operation.js";

/** Session.List — a subject's live sessions, oldest first. */
class List implements ResourceInstance<{ subject: string }, Record<string, unknown>> {
  constructor(private readonly bound: BoundSessionOperation) {}

  async invoke(inputs: { subject: string }): Promise<Record<string, unknown>> {
    return { sessions: await this.bound.sessions.list(inputs.subject) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<List> {
  return new List(new BoundSessionOperation("Session.List", resource, ctx));
}

export function register(): void {}
