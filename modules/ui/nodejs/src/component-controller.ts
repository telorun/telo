import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import type { Provided, SpecNode } from "./composite.js";
import { isComponentExport } from "./component-export-controller.js";
import type { Binding } from "./row-binding.js";

type ComponentResource = RuntimeResource & {
  component: unknown;
  props?: Record<string, Binding>;
};

class Component implements ResourceInstance {
  constructor(
    private readonly resource: ComponentResource,
    private readonly ctx: ResourceContext,
  ) {}

  async provide(): Promise<Provided> {
    const name = this.resource.metadata.name;
    const { assets, ...exported } = await this.ctx
      .resolveRef(this.resource.component, isComponentExport, () => `'component' of Ui.Component '${name}'`, "Ui.ComponentExport")
      .provide();
    const node: SpecNode = { type: "component", ...exported, props: this.resource.props ?? {} };
    return { node, assets };
  }
}

export async function create(resource: ComponentResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Component(resource, ctx);
}
