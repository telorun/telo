import type { InvokeContext, ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { asideFrame, type AsideConfig, type AsideFrame, type AsideSpec } from "./aside.js";
import { mergeAssets, type AssetFile, type SpecNode } from "./composite.js";
import { RequestNodes } from "./delivered-nodes.js";
import type { AssetsReading, PaneRequest } from "./pane.js";
import { resolvedPageWidth, type PageWidth } from "./page-width.js";
import { NOTHING } from "./request-failure.js";

type PageLayoutResource = RuntimeResource & {
  width?: PageWidth | null;
  header?: unknown[] | null;
  aside?: AsideConfig | null;
  footer?: unknown[] | null;
};

/** What a layout is invoked with. */
export interface PageLayoutInputs {
  request: PaneRequest;
  /** The application's width, used when the layout declares none. */
  pageWidth?: PageWidth | null;
}

/** A layout as delivered for one request. */
export interface PageLayoutDocument {
  width: PageWidth;
  header: SpecNode[];
  /** Absent when the layout has none. */
  aside?: AsideSpec;
  footer: SpecNode[];
}

/** A `Ui.PageLayout`, as whoever draws pages in it holds it. */
export interface PageLayoutInstance extends ResourceInstance {
  /** `context` is the invocation the request is handled under. */
  invoke(inputs: PageLayoutInputs, context?: InvokeContext): Promise<PageLayoutDocument>;
  /** Every file the layout's regions can name. */
  snapshot(): Required<AssetsReading>;
}

export function isPageLayout(candidate: unknown): candidate is PageLayoutInstance {
  const layout = candidate as Partial<PageLayoutInstance> | null;
  return typeof layout?.invoke === "function" && typeof layout.snapshot === "function";
}

/** An aside prepared once: its frame filled, what it holds delivered per request. */
interface PreparedAside {
  frame: AsideFrame;
  actions: RequestNodes;
  content: RequestNodes;
}

/** Three regions around a page, prepared once and delivered per request. */
class PageLayout implements PageLayoutInstance {
  constructor(
    private readonly width: PageWidth | undefined,
    private readonly header: RequestNodes,
    private readonly aside: PreparedAside | undefined,
    private readonly footer: RequestNodes,
    private readonly assets: AssetFile[],
  ) {}

  async invoke({ request, pageWidth }: PageLayoutInputs, context?: InvokeContext): Promise<PageLayoutDocument> {
    const [header, aside, footer] = await Promise.all([
      this.header.deliver(request, context),
      this.aside && this.deliveredAside(this.aside, request, context),
      this.footer.deliver(request, context),
    ]);
    return { width: resolvedPageWidth(this.width, pageWidth), header, ...(aside === undefined ? {} : { aside }), footer };
  }

  private async deliveredAside({ frame, actions, content }: PreparedAside, request: PaneRequest, context?: InvokeContext): Promise<AsideSpec> {
    const [drawn, held] = await Promise.all([actions.deliver(request, context), content.deliver(request, context)]);
    return { ...frame, actions: drawn, content: held[0] ?? NOTHING };
  }

  snapshot(): Required<AssetsReading> {
    return { assets: this.assets };
  }
}

export async function create(resource: PageLayoutResource, ctx: ResourceContext): Promise<PageLayoutInstance> {
  const owner = `Ui.PageLayout '${resource.metadata.name}'`;
  const header = await RequestNodes.prepare(resource.header ?? [], {}, ctx, `${owner} header`);
  const footer = await RequestNodes.prepare(resource.footer ?? [], {}, ctx, `${owner} footer`);
  let aside: PreparedAside | undefined;
  const assets: AssetFile[][] = [header.assets, footer.assets];
  if (resource.aside != null) {
    const { frame, assets: toggle } = await asideFrame(resource.aside, ctx, owner, "aside");
    const actions = await RequestNodes.prepare(resource.aside.actions ?? [], {}, ctx, `${owner} aside.actions`);
    const content = await RequestNodes.prepare([resource.aside.content], {}, ctx, `${owner} aside.content`);
    aside = { frame, actions, content };
    assets.push(toggle, actions.assets, content.assets);
  }
  return new PageLayout(resource.width ?? undefined, header, aside, footer, mergeAssets(...assets));
}
