import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { asideFrame, type AsideConfig } from "./aside.js";
import { mergeAssets, type Provided, type SpecNode } from "./composite.js";
import { filledProvided } from "./fill-marking.js";
import { resolveNode, type AuthoredNode } from "./node-resolution.js";
import { NOTHING } from "./request-failure.js";

type SplitViewResource = RuntimeResource & {
  aside: Omit<AsideConfig, "actions" | "content"> & { actions?: AuthoredNode[] | null; content: AuthoredNode };
  content: AuthoredNode;
};

/** An aside beside its content, folding away on request and into a surface on a
 *  narrow viewport; both trees resolved once, when it is created. */
class SplitView implements ResourceInstance {
  constructor(
    private readonly resource: SplitViewResource,
    private readonly ctx: ResourceContext,
  ) {}

  async provide(): Promise<Provided> {
    const { aside, content } = this.resource;
    const owner = `Ui.SplitView '${this.resource.metadata.name}'`;
    const tree = async (node: AuthoredNode, where: string) =>
      (await resolveNode(node, this.ctx, `${owner} ${where}`)) ?? { node: NOTHING, assets: [] };
    const frame = await asideFrame(aside, this.ctx, owner, "aside");
    const actions: SpecNode[] = [];
    const actionAssets: Provided["assets"][] = [];
    for (const [index, entry] of (aside.actions ?? []).entries()) {
      const drawn = await resolveNode(entry, this.ctx, `${owner} aside.actions[${index}]`);
      if (!drawn?.node) continue;
      actions.push(drawn.node);
      actionAssets.push(drawn.assets);
    }
    const held = await tree(aside.content, "aside.content");
    const beside = await tree(content, "content");
    return filledProvided({
      node: {
        type: "split",
        aside: { ...frame.frame, actions, content: held.node ?? NOTHING },
        content: beside.node ?? NOTHING,
      },
      assets: mergeAssets(frame.assets, ...actionAssets, held.assets, beside.assets),
    });
  }
}

export async function create(resource: SplitViewResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new SplitView(resource, ctx);
}
