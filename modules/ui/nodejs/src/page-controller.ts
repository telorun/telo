import type { InvokeContext, ResourceContext, ResourceInstance, RuntimeResource, TextRecord } from "@telorun/sdk";
import type { AssetFile, SpecNode } from "./composite.js";
import { RequestNodes } from "./delivered-nodes.js";
import { modelShape } from "./model-schema.js";
import { resolvedPageWidth, type PageWidth } from "./page-width.js";
import type { HeaderReads } from "./request-header-reads.js";

type PageResource = RuntimeResource & {
  path: string;
  title: TextRecord;
  query?: Record<string, unknown> | null;
  width?: PageWidth | null;
  children: unknown;
};

/** What a page is invoked with. */
export interface PageInputs {
  request: PageRequest;
  /** The application's width, used when the page declares none. */
  pageWidth?: PageWidth | null;
}

/** The request a page answers. */
export interface PageRequest {
  headers: Record<string, string>;
  ip?: string;
}

/** A page as delivered for one request. */
export interface PageDocument {
  path: string;
  title: TextRecord;
  /** The query parameters its nodes read, by name; empty when none is declared. */
  query: Record<string, unknown>;
  width: PageWidth;
  children: SpecNode[];
}

/** What a page publishes: its address, its title and what it reads. */
export interface PageReading {
  path: string;
  title: TextRecord;
  query: Record<string, unknown>;
}

/** A `Ui.Page`, as whoever lists it holds it. */
export interface PageInstance extends ResourceInstance {
  /** `context` is the invocation the request is handled under. */
  invoke(inputs: PageInputs, context?: InvokeContext): Promise<PageDocument>;
  snapshot(): PageReading;
  /** Every file the page's composites need. */
  assets(): AssetFile[];
  /** The request headers the page's expressions read. */
  headerReads(): HeaderReads;
}

export function isPage(candidate: unknown): candidate is PageInstance {
  const page = candidate as Partial<PageInstance> | null;
  return typeof page?.invoke === "function" && typeof page.snapshot === "function" && typeof page.assets === "function";
}

/** One page: its nodes prepared once, delivered per request. */
class Page implements PageInstance {
  constructor(
    private readonly reading: PageReading,
    private readonly width: PageWidth | undefined,
    private readonly nodes: RequestNodes,
  ) {}

  async invoke({ request, pageWidth }: PageInputs): Promise<PageDocument> {
    return {
      ...this.reading,
      width: resolvedPageWidth(this.width, pageWidth),
      children: this.nodes.deliver(request as unknown as Record<string, unknown>),
    };
  }

  snapshot(): PageReading {
    return this.reading;
  }

  assets(): AssetFile[] {
    return this.nodes.assets;
  }

  headerReads(): HeaderReads {
    return this.nodes.headerReads;
  }
}

export async function create(resource: PageResource, ctx: ResourceContext): Promise<PageInstance> {
  const where = `Ui.Page '${resource.metadata.name}'`;
  const query = resource.query ?? {};
  // The page's own browser root: what its declared query parameters say about
  // the values its `value` and `list` nodes name.
  const queryShape = modelShape({ type: "object", properties: query, additionalProperties: false }, { ctx, owner: where }, "query");
  const nodes = await RequestNodes.prepare(resource.children, { query: queryShape }, ctx, `${where} children`);
  return new Page({ path: resource.path, title: resource.title, query }, resource.width ?? undefined, nodes);
}
