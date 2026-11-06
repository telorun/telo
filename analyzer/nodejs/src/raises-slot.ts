/**
 * The single reader of `x-telo-raises` — a field whose presence makes the kind
 * raise codes into the catch lists around it:
 *
 * ```yaml
 * guarded:
 *   $ref: "telo://Self/Guard"
 *   x-telo-raises: [ERR_REFUSED]
 * ```
 *
 * Wherever a resource holds a value at the field, the codes reach every catch
 * list of the object holding it, every list of each resource that object reaches
 * through a `throwsThrough` slot, and every scope list above those — each list
 * receiving only the codes its own `x-telo-catches-for.raises` names. That is
 * what types a catch-all where the codes can arrive, and only there
 * (`CatchLadder.receivedOf`). Each code is named, never restated: its data lives
 * in the kind's own `throws.codes`.
 *
 * Lenient here: an unreadable value raises nothing, and {@link raisesProblems}
 * is the strict half (`RAISES_INVALID`). Read only by the analyzer.
 *
 * Browser-safe: no Node built-ins.
 */
import { resolveSchemaPointer } from "./manifest-navigation.js";
import type { ReadReporter } from "./read-place.js";
import { schemaChildren } from "./value-schema-slot.js";

export const RAISES_ANNOTATION = "x-telo-raises";

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The codes a schema node declares raised, or undefined. */
export function readRaises(node: Record<string, any> | undefined): readonly string[] | undefined {
  const raw = node?.[RAISES_ANNOTATION];
  if (!Array.isArray(raw)) return undefined;
  const codes = raw.filter((code): code is string => typeof code === "string" && CODE_PATTERN.test(code));
  return codes.length > 0 ? codes : undefined;
}

/** A field present in a resource that raises codes, and the object holding it. */
export interface RaiseSite {
  /** Concrete path of the object holding the field; `""` for the resource itself. */
  readonly holder: string;
  readonly codes: readonly string[];
}

/** Every annotated field a resource holds a value at, schema and data in tandem. */
export function raiseSites(schema: unknown, data: unknown): RaiseSite[] {
  const out: RaiseSite[] = [];
  if (!isObject(schema)) return out;
  const seen = new Set<object>();
  const deref = (node: Record<string, any>): Record<string, any> => {
    let current = node;
    const visited = new Set<object>();
    while (typeof current.$ref === "string" && current.$ref.startsWith("#") && !visited.has(current)) {
      visited.add(current);
      const target = resolveSchemaPointer(schema, current.$ref);
      if (!isObject(target)) break;
      current = target;
    }
    return current;
  };
  const walk = (node: Record<string, any>, value: unknown, path: string): void => {
    if (!isObject(node) || value === undefined || value === null) return;
    if (isObject(value) && seen.has(value)) return;
    const resolved = deref(node);
    if (Array.isArray(value)) {
      if (isObject(resolved.items)) value.forEach((item, i) => walk(resolved.items, item, `${path}[${i}]`));
      return;
    }
    if (!isObject(value)) return;
    seen.add(value);
    if (isObject(resolved.properties)) {
      for (const [key, child] of Object.entries(resolved.properties as Record<string, unknown>)) {
        if (!isObject(child) || value[key] === undefined) continue;
        const codes = readRaises(child);
        if (codes) out.push({ holder: path, codes });
        walk(child, value[key], path ? `${path}.${key}` : key);
      }
    }
  };
  walk(schema, data, "");
  return out;
}

/** What `x-telo-raises` reads: whether the field holds a value, which decides
 *  whether the codes are raised. */
export const raisesReads: ReadReporter = ({ at }) => [{ kind: "value", keys: at }];

/** Whether the concrete path `path` lies at or under the object at `holder`. */
export function withinHolder(path: string, holder: string): boolean {
  return holder === "" || path === holder || path.startsWith(`${holder}.`) || path.startsWith(`${holder}[`);
}

export interface RaisesProblem {
  /** Where the annotation is written, from the definition document. */
  readonly path: string;
  readonly message: string;
}

/**
 * Every misuse of `x-telo-raises` in a kind's schema — `RAISES_INVALID` at the
 * annotation: a value that is not a list of error codes, or a code the kind's
 * effective `throws.codes` (`declared`) does not declare, which leaves its data
 * untyped and its text unrendered.
 */
export function raisesProblems(
  definition: { metadata?: { name?: unknown }; schema?: unknown },
  declared: ReadonlySet<string>,
): RaisesProblem[] {
  const schema = definition.schema;
  if (!isObject(schema)) return [];
  const name = String(definition.metadata?.name);
  const problems: RaisesProblem[] = [];
  const seen = new Set<object>();
  const visit = (node: Record<string, any>, path: string): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const raw = node[RAISES_ANNOTATION];
    if (raw !== undefined) {
      const at = `${path}.${RAISES_ANNOTATION}`;
      if (!Array.isArray(raw)) {
        problems.push({ path: at, message: `'${name}' declares \`${RAISES_ANNOTATION}\` at '${at}' as something other than a list of error codes.` });
      } else {
        raw.forEach((code, index) => {
          if (typeof code !== "string" || !CODE_PATTERN.test(code)) {
            problems.push({
              path: `${at}[${index}]`,
              message: `'${name}' raises ${JSON.stringify(code)} at '${path}', which is not an error code (UPPER_SNAKE_CASE).`,
            });
          } else if (!declared.has(code)) {
            problems.push({
              path: `${at}[${index}]`,
              message:
                `'${name}' raises '${code}' at '${path}', but its \`throws.codes\` declares no such code. ` +
                "Declare it there, with its description, display message and data.",
            });
          }
        });
      }
    }
    for (const child of schemaChildren(node)) {
      const childPath = child.at === undefined ? `${path}.${child.keyword}` : `${path}.${child.keyword}.${child.at}`;
      if (isObject(child.schema)) visit(child.schema, childPath);
    }
  };
  visit(schema, "schema");
  return problems;
}
