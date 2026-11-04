import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { buttonSpec, providedButton, type ButtonDisplay } from "./button-display.js";
import { mergeAssets, type Provided, type SpecNode } from "./composite.js";
import { resolveNode, type AuthoredNode } from "./node-resolution.js";
import { NOTHING } from "./request-failure.js";
import { filledProvided } from "./fill-marking.js";
import { isStateStore } from "./state-store.js";
import { drawerSpec, isSurface, type SurfaceSpec } from "./surface-spec.js";

type SplitViewResource = RuntimeResource & {
  side?: "start" | "end" | null;
  size?: "small" | "medium" | "large" | null;
  frame?: "framed" | "flush" | null;
  toggle?: unknown;
  label: unknown;
  aside: { actions?: AuthoredNode[] | null; content: AuthoredNode };
  content: AuthoredNode;
  collapse?: { collapsed?: boolean | null; state?: { key: string; store: unknown } | null } | null;
  compact?: unknown;
};

/** An aside beside its content, folding away on request and into a surface on a
 *  narrow viewport. */
class SplitView implements ResourceInstance {
  constructor(
    private readonly resource: SplitViewResource,
    private readonly ctx: ResourceContext,
  ) {}

  /** The surface the aside becomes: the one written, else a drawer from the aside's side. */
  private async compactSurface(owner: string, side: "start" | "end"): Promise<SurfaceSpec> {
    const written = this.resource.compact;
    if (written == null) return drawerSpec({ side });
    const surface = await this.ctx.resolveRef(written, isSurface, () => `'compact' of ${owner}`, "Ui.ViewportOverlay").provide();
    if (surface.address !== undefined) {
      throw new RuntimeError(
        "ERR_UI_SURFACE_COMPACT_ADDRESSED",
        `${owner}: names a compact surface that declares an address. The split view has no address of its own to stand in for: remove 'address' from it.`,
      );
    }
    if (surface.compact !== undefined) {
      throw new RuntimeError(
        "ERR_UI_SURFACE_COMPACT_NESTED",
        `${owner}: names a compact surface that declares a compact surface of its own. Only one level applies: remove 'compact' from it.`,
      );
    }
    return surface;
  }

  private async collapse(owner: string): Promise<SpecNode["collapse"]> {
    const written = this.resource.collapse;
    if (written == null) return null;
    const state = written.state;
    return {
      collapsed: written.collapsed ?? false,
      state:
        state == null
          ? null
          : {
              key: state.key,
              store: await this.ctx.resolveRef(state.store, isStateStore, () => `'collapse.state.store' of ${owner}`, "Ui.StateStore").provide(),
            },
    };
  }

  /** The toggle's display, a toggle left out a glyph the look chooses, and its icon file served. */
  private async toggle(owner: string) {
    const written = this.resource.toggle;
    const display: ButtonDisplay =
      written == null ? { type: "icon", icon: null, label: "hidden" } : await providedButton(written, this.ctx, () => `'toggle' of ${owner}`);
    return buttonSpec(display, owner, "toggle.icon");
  }

  async provide(): Promise<Provided> {
    const resource = this.resource;
    const owner = `Ui.SplitView '${resource.metadata.name}'`;
    const side = resource.side ?? "start";
    const tree = async (node: AuthoredNode, where: string) =>
      (await resolveNode(node, this.ctx, `${owner} ${where}`)) ?? { node: NOTHING, assets: [] };
    const asideContent = await tree(resource.aside.content, "aside.content");
    const actions: SpecNode[] = [];
    const actionAssets: Provided["assets"][] = [];
    for (const [index, entry] of (resource.aside.actions ?? []).entries()) {
      const drawn = await resolveNode(entry, this.ctx, `${owner} aside.actions[${index}]`);
      if (!drawn?.node) continue;
      actions.push(drawn.node);
      actionAssets.push(drawn.assets);
    }
    const content = await tree(resource.content, "content");
    const toggle = await this.toggle(owner);
    return filledProvided({
      node: {
        type: "split",
        side,
        size: resource.size ?? "medium",
        frame: resource.frame ?? "flush",
        toggle: toggle.spec,
        label: resource.label,
        aside: { actions, content: asideContent.node ?? NOTHING },
        content: content.node ?? NOTHING,
        collapse: await this.collapse(owner),
        compact: await this.compactSurface(owner, side),
      },
      assets: mergeAssets(asideContent.assets, ...actionAssets, content.assets, toggle.assets),
    });
  }
}

export async function create(resource: SplitViewResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new SplitView(resource, ctx);
}
