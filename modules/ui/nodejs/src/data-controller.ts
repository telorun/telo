import {
  canonicalTypeSchemaId,
  type ResourceContext,
  type ResourceInstance,
  type RuntimeResource,
} from "@telorun/sdk";
import { addressSpec, type AddressConfig } from "./address-spec.js";
import { mergeAssets, type Provided, type SpecNode } from "./composite.js";
import { modelSchema, modelShape, type JsonSchema, type ShapeReader } from "./model-schema.js";
import { resolveNode, type AuthoredNode, type RootShapes } from "./node-resolution.js";
import { DEFAULT_FAILURE, NOTHING } from "./request-failure.js";
import { uiText } from "./spec-texts.js";
import { filledProvided } from "./fill-marking.js";
import { PAGE_PARAMS } from "./page-path.js";
import { reloadEveryOf } from "./timed-reload.js";

type Reload = "focus" | "unauthorized";

type DataResource = RuntimeResource & {
  model: unknown;
  query?: Record<string, JsonSchema> | null;
  source: AddressConfig;
  content: AuthoredNode;
  loading?: AuthoredNode | null;
  failure?: AuthoredNode | null;
  reloadOn?: Reload[] | null;
  /** A `Telo.Duration`, decoded by the kernel. */
  reloadEvery?: unknown;
};

/** What `loading` is when the author leaves it out. */
export const DEFAULT_LOADING: SpecNode = { type: "text", text: uiText("loading"), style: "muted" };

/** A record read when it is drawn, under the record contract, and the trees
 *  drawn over it. */
class Data implements ResourceInstance {
  private readonly owner: string;

  constructor(
    private readonly resource: DataResource,
    private readonly ctx: ResourceContext,
  ) {
    this.owner = `Ui.Data '${resource.metadata.name}'`;
  }

  async provide(): Promise<Provided> {
    const resource = this.resource;
    const reader: ShapeReader = { ctx: this.ctx, owner: this.owner };
    const schema = modelSchema(resource.model, this.ctx, this.owner);
    const query = resource.query ?? {};
    const queryShape = modelShape({ type: "object", properties: query, additionalProperties: false }, reader, "query");
    const error = modelShape({ $ref: canonicalTypeSchemaId("Ui", "RequestError") }, reader, "failure");
    // The placing page's variables, which only the browser knows.
    const params = modelShape(PAGE_PARAMS, reader, "params");
    const tree = async (node: AuthoredNode, where: string, roots: RootShapes) =>
      (await resolveNode(node, this.ctx, `${this.owner} ${where}`, roots)) ?? { node: NOTHING, assets: [] };
    const content = await tree(resource.content, "content", { data: modelShape(schema, reader, "model"), query: queryShape, params });
    const loading = resource.loading == null ? { node: DEFAULT_LOADING, assets: [] } : await tree(resource.loading, "loading", { query: queryShape, params });
    const failure = await tree(resource.failure ?? DEFAULT_FAILURE, "failure", { error, query: queryShape, params });
    const node: SpecNode = {
      type: "data",
      schema,
      source: addressSpec(resource.source, this.ctx, `${this.owner} source`),
      query,
      content: content.node ?? NOTHING,
      loading: loading.node ?? NOTHING,
      failure: failure.node ?? NOTHING,
      reloadOn: resource.reloadOn ?? [],
      ...reloadEveryOf(resource.reloadEvery),
    };
    return filledProvided({ node, assets: mergeAssets(content.assets, loading.assets, failure.assets) });
  }
}

export async function create(resource: DataResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Data(resource, ctx);
}
