import {
  canonicalTypeSchemaId,
  type ResourceContext,
  type ResourceInstance,
  type RuntimeResource,
} from "@telorun/sdk";
import { mergeAssets, type Provided, type SpecNode } from "./composite.js";
import { modelSchema, modelShape, type JsonSchema, type ShapeReader } from "./model-schema.js";
import { resolveNode, type AuthoredNode, type RootShapes } from "./node-resolution.js";
import { DEFAULT_FAILURE, NOTHING } from "./request-failure.js";
import type { Binding } from "./row-binding.js";
import { word } from "./spec-texts.js";

type Reload = "focus" | "unauthorized";

type DataResource = RuntimeResource & {
  model: unknown;
  query?: Record<string, JsonSchema> | null;
  source: { path: string; params?: Record<string, Binding> | null };
  content: AuthoredNode;
  loading?: AuthoredNode | null;
  failure?: AuthoredNode | null;
  reloadOn?: Reload[] | null;
};

/** What `loading` is when the author leaves it out: the renderer's own word. */
export const DEFAULT_LOADING: SpecNode = { type: "text", text: word("loading"), style: "muted" };

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
    const tree = async (node: AuthoredNode, where: string, roots: RootShapes) =>
      (await resolveNode(node, this.ctx, `${this.owner} ${where}`, roots)) ?? { node: NOTHING, assets: [] };
    const content = await tree(resource.content, "content", { data: modelShape(schema, reader, "model"), query: queryShape });
    const loading = resource.loading == null ? { node: DEFAULT_LOADING, assets: [] } : await tree(resource.loading, "loading", { query: queryShape });
    const failure = await tree(resource.failure ?? DEFAULT_FAILURE, "failure", { error, query: queryShape });
    const node: SpecNode = {
      type: "data",
      schema,
      source: { path: resource.source.path, params: resource.source.params ?? {} },
      query,
      content: content.node ?? NOTHING,
      loading: loading.node ?? NOTHING,
      failure: failure.node ?? NOTHING,
      reloadOn: resource.reloadOn ?? [],
    };
    return { node, assets: mergeAssets(content.assets, loading.assets, failure.assets) };
  }
}

export async function create(resource: DataResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Data(resource, ctx);
}
