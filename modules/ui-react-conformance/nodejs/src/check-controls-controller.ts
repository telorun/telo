import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { checkInWindow } from "./conformance-thread.js";
import { CONFORMANCE_WORKER } from "./conformance-worker.js";
import type { CheckedSet } from "./control-sets.js";
import type { Problem } from "./problem.js";
import { rendererEntries } from "./renderer-entries.js";

type CheckControlsResource = RuntimeResource & { controls: unknown };

const providesSet = (candidate: unknown): candidate is { provide(): Promise<CheckedSet> } =>
  typeof (candidate as { provide?: unknown } | null)?.provide === "function";

/** `UiReactConformance.CheckControls`: the behaviour half, over one control set. */
class CheckControls implements ResourceInstance<Record<string, never>, { problems: Problem[] }> {
  constructor(
    private readonly resource: CheckControlsResource,
    private readonly ctx: ResourceContext,
    private readonly owner: string,
  ) {}

  async invoke(): Promise<{ problems: Problem[] }> {
    const set = await this.ctx
      .resolveRef(this.resource.controls, providesSet, () => `'controls' of ${this.owner}`, "UiReact.Controls")
      .provide();
    const job = { [CONFORMANCE_WORKER]: true as const, entries: await rendererEntries(this.ctx), sets: [set] };
    return { problems: await checkInWindow(job, this.ctx, this.owner) };
  }
}

export async function create(resource: CheckControlsResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new CheckControls(resource, ctx, `UiReactConformance.CheckControls '${resource.metadata.name}'`);
}
