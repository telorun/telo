import { valueSchemaSites } from "./derived-slots.js";
import { substituteDecodedCelFields } from "./plain-literal-decoding.js";
import { type ExternalSchemaResolver, type SchemaIssue } from "./schema-compat.js";

/**
 * `x-telo-value-schema-from: "<field>"` — the value written at the annotated
 * node must satisfy the type declared at the resource's `<field>`.
 *
 * The motivating shape is a kind with ONE declared output contract and SEVERAL
 * places that must each produce it — a decision table's rows, a switch's arms.
 * Only the branch that wins at runtime gets checked there, so a mistyped branch
 * ships and fails on the one input that selects it. This annotation checks every
 * branch statically instead.
 *
 * Generic and topology-driven: the analyzer hardcodes no kind. The slots and the
 * type each resolves to come from the shared reader (`derived-slots.ts`), which
 * the kernel decodes literals through at creation. A field that resolves to no
 * schema — an optional `outputType` left undeclared — is skipped: declaring the
 * contract is what opts into the check.
 */

/** The validator holding the registered shapes, and the resolver that lets the
 *  decoding walk see through them. */
export interface ShapeAwareValidator {
  validate(data: unknown, schema: Record<string, any>): SchemaIssue[];
  external: ExternalSchemaResolver;
}

/**
 * Validate every `x-telo-value-schema-from` slot in one resource.
 *
 * CEL leaves are replaced with schema-shaped placeholders before AJV runs
 * (`substituteCelFields`), so an expression is accepted wherever its slot's
 * declared type would be, and a literal in a value type's plain encoding is
 * decoded. What this DOES catch is structural disagreement no runtime value can
 * fix: a missing required property, an unknown property under
 * `additionalProperties: false`, or a literal of the wrong type. A shape the type
 * names is seen through by the decoding walk and the validator alike.
 */
export function collectValueSchemaIssues(
  manifest: Record<string, any>,
  defSchema: Record<string, any> | undefined,
  allManifests: Record<string, any>[],
  validator: ShapeAwareValidator,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  for (const { path, value, schema, from } of valueSchemaSites(manifest, defSchema, {
    typeManifests: allManifests,
  })) {
    const substituted = substituteDecodedCelFields(value, schema, undefined, {
      external: validator.external,
    });
    for (const issue of validator.validate(substituted, schema)) {
      issues.push({
        message: `\`${path}\` does not satisfy the type declared at \`${from}\`: ${issue.message}`,
        path: issue.path ? `${path}.${issue.path}` : path,
      });
    }
  }
  return issues;
}
