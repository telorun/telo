import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundOperation, type OperationResource } from "./one-time-operation.js";

/** OneTime.Issue — issues a token for a subject, or says how long to wait. */
class Issue implements ResourceInstance<{ subject: string; data?: unknown; holder?: string | null }, unknown> {
  constructor(private readonly bound: BoundOperation) {}

  async invoke(inputs: { subject: string; data?: unknown; holder?: string | null }): Promise<unknown> {
    const tokens = this.bound.tokens;
    tokens.requireData(inputs.data);
    return tokens.issue(inputs);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<Issue> {
  return new Issue(new BoundOperation("OneTime.Issue", resource, ctx));
}

export function register(): void {}
