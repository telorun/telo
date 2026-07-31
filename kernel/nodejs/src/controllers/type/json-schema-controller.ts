import { evaluate } from "@marcbachmann/cel-js";
import type {
  ResourceContext,
  ResourceInstance,
  ResourceManifest,
  TypeRule,
} from "@telorun/sdk";
import { canonicalTypeSchemaId, mergeTypeSchemas, RuntimeError } from "@telorun/sdk";

/**
 * `Telo.JsonSchema` — a named data shape.
 *
 * It lives in the kernel rather than in an installable module for the same
 * reason the mandatory log sinks do: declaring a shape is not optional. Every
 * kind that carries an invocation contract needs one, so requiring an import to
 * write `inputType:` would tax the exact thing contracts want authors to do —
 * and a library declaring its own contract would have to import a module purely
 * to describe itself.
 *
 * `type.JsonSchema` is retained as a deprecated alias with the same behaviour, so
 * published manifests keep resolving.
 */
class JsonSchemaType {
  constructor(
    private readonly qualifiedName: string,
    private readonly rules: TypeRule[],
    /** The fully-resolved (post-`extends`), self-contained JSON Schema. Read by
     *  consumers that need the effective shape — e.g. a templated resource
     *  threading `${{ self.model.schema }}` into a request validation schema. */
    readonly schema: Record<string, unknown>,
  ) {}

  /**
   * Validate data against this type's CEL rules — the invariant layer on top of
   * the schema itself, which AJV enforces through the schema registry.
   */
  validateRules(data: unknown): void {
    for (const rule of this.rules) {
      let result: unknown;
      try {
        result = evaluate(rule.condition, { this: data });
      } catch (err) {
        throw new RuntimeError(
          "ERR_TYPE_VALIDATION_FAILED",
          `Type "${this.qualifiedName}" rule evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (result !== true) {
        throw new RuntimeError(
          rule.code,
          rule.message ??
            `Type "${this.qualifiedName}" validation failed: rule "${rule.code}" not satisfied`,
        );
      }
    }
  }
}

/** A type resource is pure declaration: it registers a schema and holds the
 *  resolved shape, implementing none of the lifecycle verbs. `ResourceInstance`
 *  is entirely optional members, so a class with none of them satisfies it only
 *  by assertion — the same shape the module-loaded controller had, where the
 *  dynamic-import boundary erased the type instead of asserting it. */
export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<ResourceInstance | null> {
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

  // Also register under the short name so types can be referenced without a
  // module prefix.
  const shortName = resource.metadata.name;
  if (shortName !== qualifiedName) {
    ctx.registerSchema(shortName, schema);
    ctx.registerTypeRules(shortName, rules);
  }

  // Canonical module-scoped id — the target of `$ref: "telo://Self/<name>"` (and
  // `telo://<Alias>/<name>` across imports) once the loader resolves the
  // authority to this module. Authority-free, so a validator can actually
  // resolve the reference; see `canonicalTypeSchemaId`.
  const moduleName = resource.metadata.module as string | undefined;
  if (moduleName) {
    ctx.registerSchema(canonicalTypeSchemaId(moduleName, shortName), schema);
  }

  return new JsonSchemaType(qualifiedName, rules, schema) as unknown as ResourceInstance;
}
