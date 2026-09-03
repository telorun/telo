import { collectProperties, selectUnionBranch } from "@telorun/analyzer";
import { isRecord } from "../../../../lib/utils";
import { parseConcretePath } from "../../../../lib/concrete-path";

/**
 * The schema of ONE entry of an ordered array — a boot target, a mount, a
 * route, a step — resolved against the kind that declares the array.
 *
 * A row IS that entry, so it is what a click on the row should open: the entry
 * carries the configuration a reader came for (`when:`, `inputs:`, `retry:`, a
 * route's `path` and `method`), while the resource at the far end has a box of
 * its own. It is also always in THIS module's YAML, which the resource may not
 * be.
 *
 * **The union is resolved by the VALUE, not offered as a choice.** A boot target
 * is a union — a bare reference, a gated `ref:`, an invoke step — and so is the
 * shared step grammar. Which one an entry IS, is decided by what is written
 * there, and the analyzer already answers that for the kernel
 * (`selectUnionBranch`), so the panel and the runtime cannot disagree about
 * which branch a value was written against. Offering the choice instead would
 * mean a variant picker in the form and a second answer to the same question.
 */

/** Follow a document-local `$ref`, or give up.
 *
 *  Giving up rather than throwing: a schema-valued slot carries a `telo:` id the
 *  editor's resolver refuses, and the caller's answer to "cannot resolve" is to
 *  show the host instead — a thrown error from a click handler is not. */
function deref(node: unknown, root: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isRecord(node)) return undefined;
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  if (!ref.startsWith("#/")) return undefined;
  let resolved: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isRecord(resolved)) return undefined;
    resolved = resolved[segment];
  }
  return isRecord(resolved) ? resolved : undefined;
}

/**
 * Does anything under here still point somewhere?
 *
 * The form resolves no references — it reads `type`, `properties` and `items`
 * and nothing else — so a schema still carrying one renders as whatever
 * `inferType` guesses, which for a nested step body is a single-line text box
 * where a list of statements belongs. A control-flow step is the real case:
 * its arms are arrays of the step grammar, which is recursive and reaches
 * itself by reference.
 *
 * So this is the honest gate: a schema the form cannot render in full is not
 * rendered at all, and the click falls back to the host.
 */
function hasUnresolvedRef(node: unknown, depth = 0): boolean {
  if (depth > 12 || !isRecord(node)) return false;
  if (typeof node.$ref === "string") return true;
  return Object.values(node).some((child) =>
    Array.isArray(child)
      ? child.some((item) => hasUnresolvedRef(item, depth + 1))
      : hasUnresolvedRef(child, depth + 1),
  );
}

/**
 * Walk a CONCRETE array path (`targets`, `routes`, `steps[0].do`) to the array
 * it names, then to the shape of one of its entries.
 *
 * Concrete rather than a slot path because that is what a row carries, and an
 * index means "descend into the element" — `steps[0].do` is the `do` of a step,
 * so the walk enters `items` before reading the next property.
 */
export function entrySchemaFor(
  kindSchema: Record<string, unknown> | undefined,
  arrayPath: string,
  /** The entry as written, which decides which branch of a union it is. */
  value: unknown,
): Record<string, unknown> | undefined {
  if (!kindSchema) return undefined;
  let node: Record<string, unknown> | undefined = kindSchema;
  for (const { key, index } of parseConcretePath(arrayPath)) {
    // Through the analyzer's own rule, because an intermediate node may be a
    // UNION: the step an inner body hangs off is one, so reading `properties`
    // alone stopped the walk at the first nesting level. `collectProperties`
    // contributes a branch's property when no branch already declared it, which
    // is what "the `do` of a step" means when only one branch has a `do`.
    node = deref(collectProperties(node)[key], kindSchema);
    if (!node) return undefined;
    if (index !== undefined) {
      node = deref(node.items, kindSchema);
      if (!node) return undefined;
    }
  }
  const items = deref(node.items, kindSchema);
  if (!items) return undefined;

  const branch = selectUnionBranch(items, value, kindSchema);
  // Renderable means an OBJECT with declared properties: the panel edits a
  // pointer's object body, so an entry written as a bare reference has no form
  // to show — and a union nothing selected is still the union, which the form
  // would render as no fields at all.
  if (!isRecord(branch) || !isRecord(branch.properties)) return undefined;
  if (hasUnresolvedRef(branch)) return undefined;
  return branch;
}
