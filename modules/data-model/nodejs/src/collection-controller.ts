import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { readCollection, type CollectionDeclaration } from "./collection-declaration.js";
import { collectionProblems } from "./collection-problems.js";

/** A collection: its model, key, declared query and relations, read once and
 *  checked against each other before anything is served from them. */
class Collection implements ResourceInstance {
  private declaration?: CollectionDeclaration;

  constructor(
    private readonly resource: RuntimeResource,
    private readonly ctx: ResourceContext,
  ) {}

  private read(): CollectionDeclaration {
    if (this.declaration) return this.declaration;
    const owner = `DataModel.Collection '${this.resource.metadata.name}'`;
    const declaration = readCollection(this.resource, this.ctx, owner);
    const [problem] = collectionProblems(declaration.model, declaration.key, declaration.query, declaration.relations);
    if (problem) throw new RuntimeError(`ERR_${problem.code}`, `${owner}: ${problem.message}`);
    return (this.declaration = declaration);
  }

  init(): void {
    this.read();
  }

  snapshot(): Record<string, unknown> {
    const { model, key, query } = this.read();
    return { model: { schema: model }, key, query };
  }
}

export async function create(resource: RuntimeResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Collection(resource, ctx);
}
