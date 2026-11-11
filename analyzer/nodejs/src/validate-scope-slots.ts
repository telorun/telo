/**
 * Where an `x-telo-scope` annotation may sit: on a NAMED TOP-LEVEL PROPERTY of
 * the resource — a property in the root's `properties` or in a root `anyOf` /
 * `oneOf` / `allOf` branch's, its schema written directly or through a local
 * `$ref`. A scope run stands its declarations up from that one field of the
 * resource; nested under an object or an array item, under a map value, inside
 * a recursive shape or below an `x-telo-schema-from` expansion there is no single
 * field to stand it up from.
 *
 * One reader for both halves: `telo check` reports `SCOPE_SLOT_MISPLACED` at the
 * annotation, and the kernel raises `ERR_SCOPE_SLOT_MISPLACED` when it registers
 * the definition, so a dependency's kind is refused too.
 *
 * Browser-safe: no Node built-ins.
 */
import { misplacedScopeSlots } from "./reference-reach.js";
import { openedByCapabilityProblem, scopeAnnotationProblem } from "./scope-annotation.js";

export interface ScopeSlotProblem {
  /** Where the annotation is written, from the definition document
   *  (`schema.properties.a.properties.with.x-telo-scope`). */
  path: string;
  message: string;
}

/** Every `x-telo-scope` a definition's own `schema:` writes off a named
 *  top-level property. */
export function scopeSlotProblems(definition: {
  metadata?: { name?: unknown };
  schema?: unknown;
}): ScopeSlotProblem[] {
  const schema = definition.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  return misplacedScopeSlots(schema as Record<string, any>).map(({ location, reason }) => {
    const path = `${location ? `schema.${location}` : "schema"}.x-telo-scope`;
    return {
      path,
      message:
        `'${String(definition.metadata?.name)}' declares \`x-telo-scope\` at '${path}', where no ` +
        `scope can be stood up: ${reason}. A scope belongs on a named top-level property — one ` +
        `in the schema root's \`properties\` or in a root \`anyOf\` / \`oneOf\` / \`allOf\` ` +
        `branch's, written directly or through a local \`$ref\`. Move the annotation there.`,
    };
  });
}

/**
 * Every `x-telo-scope` a definition's own `schema:` writes in the object form
 * that the kind cannot honour: a malformed object, or `openedBy: dispatch` on a
 * kind whose `capability` (its own or inherited) has no `invoke()` or `run()`.
 * `telo check` reports `SCOPE_OPENED_BY_INVALID` at the annotation; the kernel
 * raises `ERR_SCOPE_OPENED_BY_INVALID` when it registers the definition.
 */
export function scopeOpenedByProblems(
  definition: { metadata?: { name?: unknown }; schema?: unknown },
  capability: string | undefined,
): ScopeSlotProblem[] {
  const schema = definition.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const out: ScopeSlotProblem[] = [];
  const seen = new Set<object>();
  const scan = (value: unknown, at: string): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, i) => scan(item, `${at}[${i}]`));
      return;
    }
    const node = value as Record<string, unknown>;
    if ("x-telo-scope" in node) {
      const annotation = node["x-telo-scope"];
      const reason = scopeAnnotationProblem(annotation) ?? openedByCapabilityProblem(annotation, capability);
      if (reason !== undefined) {
        const path = `${at}.x-telo-scope`;
        out.push({
          path,
          message: `'${String(definition.metadata?.name)}' declares \`x-telo-scope\` at '${path}' that it cannot honour: ${reason}.`,
        });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "x-telo-scope") scan(child, `${at}.${key}`);
    }
  };
  scan(schema, "schema");
  return out;
}
