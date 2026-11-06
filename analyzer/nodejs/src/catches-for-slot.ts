/**
 * The single reader of `x-telo-catches-for` — whose failures a catch list
 * renders, and which codes the kind raises into the list itself.
 *
 * The string form names the sibling field holding the handler (the EMPTY
 * string for everything the resource drives). The object form adds `raises`:
 *
 * ```yaml
 * catches:
 *   x-telo-outcome-list: catches
 *   x-telo-catches-for: { slot: handler, raises: [ERR_REFUSED] }
 * ```
 *
 * A raised code is one the holder answers itself before or beside the handler
 * (a transport refusing a request) and renders by default when no entry claims
 * it. It is named, never restated: its description, display message and `data`
 * live in the kind's own `throws.codes`. A list may name it in a proving `when:`
 * and reads its `data`, every list above it on the scope ladder may too, and no
 * site owes its coverage.
 *
 * Lenient here, the `ref-slot.ts` precedent: an unreadable value reads as
 * absent, and {@link catchesForProblems} is the strict half. Read only by the
 * analyzer; the holder's controller renders what it raises.
 *
 * Browser-safe: no Node built-ins.
 */
import { schemaChildren } from "./value-schema-slot.js";

export const CATCHES_FOR_ANNOTATION = "x-telo-catches-for";

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export interface CatchesFor {
  /** The sibling field naming the handler; empty for a scope list. */
  readonly slot: string;
  /** Codes the kind raises into the list itself. */
  readonly raises: readonly string[];
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The annotation on one schema node, or undefined when it is absent or unreadable. */
export function readCatchesFor(node: Record<string, any> | undefined): CatchesFor | undefined {
  const raw = node?.[CATCHES_FOR_ANNOTATION];
  if (typeof raw === "string") return { slot: raw, raises: [] };
  if (!isObject(raw) || typeof raw.slot !== "string") return undefined;
  const raises = Array.isArray(raw.raises)
    ? raw.raises.filter((code: unknown): code is string => typeof code === "string" && CODE_PATTERN.test(code))
    : [];
  return { slot: raw.slot, raises };
}

export interface CatchesForProblem {
  /** Where the annotation is written, from the definition document. */
  readonly path: string;
  readonly message: string;
}

/**
 * Every way a kind's `x-telo-catches-for` object form is misplaced or names a
 * code it does not declare — `CATCHES_FOR_INVALID` at the annotation. `declared`
 * is the kind's effective `throws.codes`. A raised code the kind does not
 * declare has nothing to type its `data` from and nothing for the controller to
 * render its text with.
 */
export function catchesForProblems(
  definition: { metadata?: { name?: unknown }; schema?: unknown },
  declared: ReadonlySet<string>,
): CatchesForProblem[] {
  const schema = definition.schema;
  if (!isObject(schema)) return [];
  const name = String(definition.metadata?.name);
  const problems: CatchesForProblem[] = [];
  const seen = new Set<object>();
  const visit = (node: Record<string, any>, path: string): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const raw = node[CATCHES_FOR_ANNOTATION];
    if (isObject(raw)) {
      const at = `${path}.${CATCHES_FOR_ANNOTATION}`;
      if (node["x-telo-outcome-list"] !== "catches") {
        problems.push({
          path: at,
          message:
            `'${name}' declares the object form of \`${CATCHES_FOR_ANNOTATION}\` at '${at}', which is ` +
            "not a catch list. It belongs beside `x-telo-outcome-list: catches`.",
        });
      }
      const raises: unknown[] = Array.isArray(raw.raises) ? raw.raises : [];
      raises.forEach((code, index) => {
        if (typeof code !== "string" || !CODE_PATTERN.test(code)) {
          problems.push({
            path: `${at}.raises[${index}]`,
            message: `'${name}' raises ${JSON.stringify(code)} into the catch list at '${path}', which is not an error code (UPPER_SNAKE_CASE).`,
          });
        } else if (!declared.has(code)) {
          problems.push({
            path: `${at}.raises[${index}]`,
            message:
              `'${name}' raises '${code}' into the catch list at '${path}', but its \`throws.codes\` ` +
              `declares no such code. Declare it there, with its description, display message and data.`,
          });
        }
      });
    }
    for (const child of schemaChildren(node)) {
      const childPath = child.at === undefined ? `${path}.${child.keyword}` : `${path}.${child.keyword}.${child.at}`;
      if (isObject(child.schema)) visit(child.schema, childPath);
    }
  };
  visit(schema, "schema");
  return problems;
}
