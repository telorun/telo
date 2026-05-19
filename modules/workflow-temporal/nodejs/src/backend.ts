import type {
  ControllerContext,
  ResourceContext,
  ResourceInstance,
  RuntimeResource,
} from "@telorun/sdk";

type WorkflowTemporalBackendResource = RuntimeResource & {
  namespace?: string;
  address?: string;
};

export function register(_ctx: ControllerContext): void {}

/**
 * Stub controller for `Workflow-Temporal.Backend`. The real Temporal SDK
 * integration is not yet implemented; this resource currently exists only so
 * that consumers can statically declare `kind: Temporal.Backend` and have the
 * analyzer accept the wiring into `Workflow.Graph.backend`. Booting a manifest
 * that actually exercises the backend will surface an error when
 * `Workflow.Graph` tries to invoke methods that don't exist on this stub.
 */
class WorkflowTemporalBackend implements ResourceInstance {
  constructor(private readonly resource: WorkflowTemporalBackendResource) {}

  async init(): Promise<void> {}

  snapshot(): Record<string, unknown> {
    return {
      namespace: this.resource.namespace,
      address: this.resource.address,
    };
  }
}

export async function create(
  resource: WorkflowTemporalBackendResource,
  _ctx: ResourceContext,
): Promise<WorkflowTemporalBackend> {
  return new WorkflowTemporalBackend(resource);
}
