import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundSessionOperation, type OperationResource } from "./session-operation.js";

interface EndAllInputs {
  subject: string;
  except?: string | null;
}

/** Session.EndAll — ends every session of a subject, or all but one, in a single write. */
class EndAll implements ResourceInstance<EndAllInputs, { ended: string[] }> {
  constructor(private readonly bound: BoundSessionOperation) {}

  async invoke(inputs: EndAllInputs): Promise<{ ended: string[] }> {
    return { ended: await this.bound.sessions.endAll(inputs.subject, inputs.except ?? undefined) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<EndAll> {
  return new EndAll(new BoundSessionOperation("Session.EndAll", resource, ctx));
}

export function register(): void {}
