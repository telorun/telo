import { ResourceContext, ResourceInstance, ResourceManifest } from "@telorun/sdk";

class DataTypeResource implements ResourceInstance {}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<DataTypeResource | null> {
  const qualifiedName = `${resource.metadata.module}.${resource.metadata.name}`;
  let schema = resource.schema as object;

  const extendsField = resource.extends as string | string[] | undefined;
  if (extendsField) {
    const parents = Array.isArray(extendsField) ? extendsField : [extendsField];

    // Defer if any parent schema isn't registered yet (multi-pass resolution)
    for (const parent of parents) {
      if (!ctx.lookupSchema(parent)) {
        return null;
      }
    }

    // Merge: allOf [{ $ref: "Parent" }, ..., ownSchema]
    schema = {
      allOf: [...parents.map((p) => ({ $ref: p })), schema],
    };
  }

  ctx.registerSchema(qualifiedName, schema);
  return new DataTypeResource();
}
