import { substituteCelFields, validateAgainstSchema, type SchemaIssue } from "./schema-compat.js";
import { resolveTypeFieldToSchema } from "./validate-cel-context.js";

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
 * Generic and topology-driven: the analyzer hardcodes no kind. Any definition
 * with a `telo#Type` field and value-producing slots opts in by annotating those
 * slots. `<field>` is resolved with the same `telo#Type` semantics as
 * `inputType` / `outputType` everywhere else, so an inline
 * `{ kind: Type.JsonSchema, schema: … }` and a named type reference both work.
 *
 * A field that resolves to no schema — the common case of an optional
 * `outputType` left undeclared — is skipped, not reported: declaring the
 * contract is what opts into the check.
 */
const ANNOTATION = "x-telo-value-schema-from";

interface Annotation {
  /** JSONPath-ish scope into the manifest, e.g. `$.choices[*].value`. */
  scope: string;
  /** Resource field naming the type to validate against, e.g. `outputType`. */
  from: string;
}

/** Walk a definition schema collecting every `x-telo-value-schema-from`, in the
 *  same scope form the CEL-context walker produces. */
function collectAnnotations(schema: Record<string, any>, path: string): Annotation[] {
  if (!schema || typeof schema !== "object") return [];
  const out: Annotation[] = [];

  const from = schema[ANNOTATION];
  if (typeof from === "string" && from.length > 0) out.push({ scope: path, from });

  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties as Record<string, any>)) {
      out.push(...collectAnnotations(value, `${path}.${key}`));
    }
  }
  if (schema.items && typeof schema.items === "object") {
    out.push(...collectAnnotations(schema.items, `${path}[*]`));
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const sub of schema[key]) out.push(...collectAnnotations(sub, path));
    }
  }
  return out;
}

/** Expand a scope into the concrete values present in this manifest, carrying
 *  each one's real path so a diagnostic points at the row the author wrote. */
function resolveScopeValues(
  manifest: Record<string, any>,
  scope: string,
): Array<{ path: string; value: unknown }> {
  const stripped = scope.startsWith("$.") ? scope.slice(2) : scope;
  if (!stripped) return [];

  let frontier: Array<{ path: string; value: unknown }> = [{ path: "", value: manifest }];
  // Segments look like `choices[*]` or `default` — a name plus optional wildcard.
  for (const segment of stripped.split(".")) {
    const wildcard = segment.endsWith("[*]");
    const name = wildcard ? segment.slice(0, -3) : segment;
    const next: Array<{ path: string; value: unknown }> = [];
    for (const entry of frontier) {
      const container = entry.value as Record<string, unknown> | undefined;
      if (!container || typeof container !== "object") continue;
      const child = container[name];
      if (child === undefined) continue;
      const childPath = entry.path ? `${entry.path}.${name}` : name;
      if (!wildcard) {
        next.push({ path: childPath, value: child });
        continue;
      }
      if (!Array.isArray(child)) continue;
      child.forEach((item, i) => next.push({ path: `${childPath}[${i}]`, value: item }));
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return frontier;
}

/**
 * Validate every `x-telo-value-schema-from` slot in one resource.
 *
 * CEL leaves are replaced with schema-shaped placeholders before AJV runs
 * (`substituteCelFields`), so an expression is accepted wherever its slot's
 * declared type would be — a static pass cannot know what it evaluates to. What
 * this DOES catch is structural disagreement that no runtime value can fix: a
 * missing required property, an unknown property under
 * `additionalProperties: false`, or a literal of the wrong type.
 */
export function collectValueSchemaIssues(
  manifest: Record<string, any>,
  defSchema: Record<string, any> | undefined,
  allManifests: Record<string, any>[],
): SchemaIssue[] {
  if (!defSchema) return [];
  const annotations = collectAnnotations(defSchema, "$");
  if (annotations.length === 0) return [];

  const issues: SchemaIssue[] = [];
  for (const { scope, from } of annotations) {
    const target = resolveTypeFieldToSchema(manifest[from], allManifests);
    if (!target || typeof target !== "object") continue;

    for (const { path, value } of resolveScopeValues(manifest, scope)) {
      for (const issue of validateAgainstSchema(substituteCelFields(value, target), target)) {
        issues.push({
          message: `\`${path}\` does not satisfy the type declared at \`${from}\`: ${issue.message}`,
          path: issue.path ? `${path}.${issue.path}` : path,
        });
      }
    }
  }
  return issues;
}
