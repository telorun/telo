import type { ResourceContext, ResourceManifest, TypeRule } from "@telorun/sdk";
import { canonicalTypeSchemaId, mergeTypeSchemas } from "@telorun/sdk";

class TypeResource {
  constructor(
    private readonly qualifiedName: string,
    private readonly rules: TypeRule[],
    /** The fully-resolved (post-`extends`), self-contained JSON Schema. Read by
     *  consumers that need the effective shape — e.g. a templated resource
     *  threading `${{ self.model.schema }}` into an HTTP request validation
     *  schema. */
    readonly schema: Record<string, unknown>,
  ) {}
}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<TypeResource | null> {
  const qualifiedName = `${resource.metadata.module}.${resource.metadata.name}`;
  const ownSchema = resource.schema as Record<string, unknown>;

  let schema: Record<string, unknown> = ownSchema;

  const extendsField = resource.extends as string | string[] | undefined;
  if (extendsField) {
    const parents = Array.isArray(extendsField) ? extendsField : [extendsField];

    const parentSchemas: Record<string, unknown>[] = [];
    for (const parent of parents) {
      const parentSchema = ctx.lookupSchema(parent);
      // Defer if any parent schema isn't registered yet (multi-pass resolution).
      if (!parentSchema) return null;
      parentSchemas.push(parentSchema as Record<string, unknown>);
    }

    // Each parent's registered schema is itself already resolved, so merging
    // them makes inheritance transitive through grandparents with no `$ref`s
    // left in the result.
    schema = mergeTypeSchemas([...parentSchemas, ownSchema]);
  }

  const rules = (Array.isArray(resource.rules) ? resource.rules : []) as TypeRule[];

  ctx.registerSchema(qualifiedName, schema);
  ctx.registerTypeRules(qualifiedName, rules);

  // Also register under the short name so types can be referenced without module prefix
  const shortName = resource.metadata.name;
  if (shortName !== qualifiedName) {
    ctx.registerSchema(shortName, schema);
    ctx.registerTypeRules(shortName, rules);
  }

  // Canonical module-scoped URI `$id` — the target of `$ref: "telo://Self/<name>"`
  // (and `telo://<Alias>/<name>` across imports) once the loader resolves the
  // authority to this module. Lets a sibling schema reference this type with a
  // standard JSON Schema `$ref`.
  const moduleName = resource.metadata.module as string | undefined;
  if (moduleName) {
    ctx.registerSchema(canonicalTypeSchemaId(moduleName, shortName), schema);
  }

  return new TypeResource(qualifiedName, rules, schema);
}
