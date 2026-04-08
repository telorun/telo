import { evaluate } from "@marcbachmann/cel-js";
import type { ResourceContext, ResourceManifest, TypeRule } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";

class TypeResource {
  constructor(
    private readonly qualifiedName: string,
    private readonly rules: TypeRule[],
  ) {}

  /**
   * Validate data against this type's rules (CEL conditions).
   * Schema validation is handled by AJV via the schema registry;
   * this method evaluates the business-rule layer on top.
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
          rule.message ?? `Type "${this.qualifiedName}" validation failed: rule "${rule.code}" not satisfied`,
        );
      }
    }
  }
}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<TypeResource | null> {
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

  const rules = (Array.isArray(resource.rules) ? resource.rules : []) as TypeRule[];

  ctx.registerSchema(qualifiedName, schema);
  ctx.registerTypeRules(qualifiedName, rules);

  // Also register under the short name so types can be referenced without module prefix
  const shortName = resource.metadata.name;
  if (shortName !== qualifiedName) {
    ctx.registerSchema(shortName, schema);
    ctx.registerTypeRules(shortName, rules);
  }

  return new TypeResource(qualifiedName, rules);
}
