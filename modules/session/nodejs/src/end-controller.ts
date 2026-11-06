import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundSessionOperation, type OperationResource } from "./session-operation.js";

interface EndInputs {
  sessionId: string;
  subject: string;
}

/** Session.End — ends one session of a subject; another subject's session is not ended. */
class End implements ResourceInstance<EndInputs, { ended: boolean }> {
  constructor(private readonly bound: BoundSessionOperation) {}

  async invoke(inputs: EndInputs): Promise<{ ended: boolean }> {
    return { ended: await this.bound.sessions.end(inputs.subject, inputs.sessionId) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<End> {
  return new End(new BoundSessionOperation("Session.End", resource, ctx));
}

export function register(): void {}
