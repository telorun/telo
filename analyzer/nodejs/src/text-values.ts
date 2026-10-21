/**
 * `x-telo-text-values: { <name>: <schema> }` — the one reader of the annotation's
 * placement (`TEXT_VALUES_INVALID` statically, at the kind or the `imports:` entry
 * reaching a dependency's; `ERR_TEXT_VALUES_INVALID` when the kernel registers the
 * definition) and of what it declares.
 *
 * Written on a `Text` / `Message` node, it states the values whoever reads the text
 * formats it with — a renderer formatting a label in the browser, a controller
 * formatting a message itself — so a placeholder or a plural selector no reader
 * binds is refused where the text is written, as a values pairing
 * (`x-telo-text-values-for`) refuses one its values do not bind. `{}` declares that
 * the text is formatted with no values.
 *
 * Browser-safe: no Node built-ins.
 */
import { parseCanonicalTypeSchemaId } from "@telorun/sdk";
import { resolveSchemaPointer } from "./manifest-navigation.js";
import { judgeValues, schemaValueKind, type KnownValues, type TextProblem } from "./text-judgement.js";
import {
  pointerSegments,
  renderValuePath,
  TEXT_VALUES_ANNOTATION,
  TEXT_VALUES_FOR_ANNOTATION,
  textFragmentOf,
  type ValuePath,
} from "./text-slot.js";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema => !!node && typeof node === "object" && !Array.isArray(node);

/** The declared values, as the kinds a message judges values by. */
export function declaredValueKinds(declared: Readonly<Record<string, unknown>>): KnownValues {
  return new Map(Object.entries(declared).map(([name, schema]) => [name, schemaValueKind(schema)]));
}

export interface TextValuesProblem {
  /** Where the annotation is written, from the kind document. */
  readonly path: string;
  readonly message: string;
}

/** The text fragment a node is, or reaches through a `$ref`. */
function fragmentAt(node: Schema, root: Schema, resolveRef: ((ref: string) => Schema | undefined) | undefined) {
  const own = textFragmentOf(node);
  if (own !== undefined) return own;
  if (typeof node.$ref !== "string") return undefined;
  const target = node.$ref.startsWith("#") ? resolveSchemaPointer(root, node.$ref) : resolveRef?.(node.$ref);
  return isSchema(target) ? textFragmentOf(target) : undefined;
}

/**
 * Every misplaced `x-telo-text-values` a kind's schema reaches — through
 * properties, map values, list items, unions, document-local references and named
 * shapes: not on a `Text` / `Message` node, a declared value whose schema is
 * neither a string nor a number, or a text a values pairing already binds.
 */
export function textValuesProblems(
  kind: string,
  schema: unknown,
  resolveRef?: (ref: string) => Schema | undefined,
  at: ValuePath = ["schema"],
): TextValuesProblem[] {
  if (!isSchema(schema)) return [];
  const problems: TextValuesProblem[] = [];
  const visited = new Set<object>();
  const report = (path: ValuePath, shape: string | undefined, inner: ValuePath, reason: string) => {
    const where = renderValuePath(shape ? path : [...path, TEXT_VALUES_ANNOTATION]);
    const place = shape
      ? `'${where}', which reaches '${renderValuePath([...inner, TEXT_VALUES_ANNOTATION])}' in the named shape '${shape}' it names,`
      : `'${where}'`;
    problems.push({ path: where, message: `'${kind}' declares ${place} ${reason}` });
  };
  const visit = (node: unknown, root: Schema, path: ValuePath, shape: string | undefined, inner: ValuePath): void => {
    if (!isSchema(node) || visited.has(node)) return;
    visited.add(node);
    const step = (key: ValuePath): [ValuePath, ValuePath] => (shape ? [path, [...inner, ...key]] : [[...path, ...key], inner]);
    if (TEXT_VALUES_ANNOTATION in node) {
      const declared = node[TEXT_VALUES_ANNOTATION];
      const fragment = fragmentAt(node, root, resolveRef);
      if (fragment !== "Text" && fragment !== "Message") {
        report(path, shape, inner, "on a node that is no text: it declares the values a Text or a Message is formatted with, so write it beside the text's `$ref: telo://manifest#/$defs/Text`.");
      } else if (!isSchema(declared)) {
        report(path, shape, inner, "as something other than a map of value names to their schemas. Write `{}` for a text formatted with no values.");
      } else {
        for (const [name, value] of Object.entries(declared)) {
          const type = isSchema(value) ? value.type : undefined;
          if (type !== "string" && type !== "integer" && type !== "number") {
            report(path, shape, inner, `with '${name}' typed as neither a string nor a number: a message formats only those. Declare it 'type: string', 'integer' or 'number'.`);
          }
        }
      }
    }
    if (isSchema(node.properties)) {
      // A text a sibling pairs values with is formatted with those values.
      for (const [key, child] of Object.entries(node.properties)) {
        const segments = pointerSegments(isSchema(child) ? child[TEXT_VALUES_FOR_ANNOTATION] : undefined);
        if (!segments) continue;
        let target: unknown = node;
        for (const segment of segments) target = isSchema(target) && isSchema(target.properties) ? target.properties[segment] : undefined;
        if (isSchema(target) && TEXT_VALUES_ANNOTATION in target) {
          const [p, i] = step(["properties", ...segments.flatMap((segment, n) => (n === 0 ? [segment] : ["properties", segment]))]);
          report(p, shape, i, `on a text '${key}' already pairs with values through x-telo-text-values-for: the text is formatted with those. Remove one of the two.`);
        }
      }
      for (const [key, child] of Object.entries(node.properties)) {
        const [p, i] = step(["properties", key]);
        visit(child, root, p, shape, i);
      }
    }
    for (const mapKey of ["patternProperties", "$defs", "definitions"] as const) {
      if (!isSchema(node[mapKey])) continue;
      for (const [key, child] of Object.entries(node[mapKey])) {
        const [p, i] = step([mapKey, key]);
        visit(child, root, p, shape, i);
      }
    }
    for (const single of ["additionalProperties", "items", "then", "else"] as const) {
      if (isSchema(node[single])) {
        const [p, i] = step([single]);
        visit(node[single], root, p, shape, i);
      }
    }
    for (const union of ["oneOf", "anyOf", "allOf"] as const) {
      if (Array.isArray(node[union])) {
        node[union].forEach((branch: unknown, index: number) => {
          const [p, i] = step([union, index]);
          visit(branch, root, p, shape, i);
        });
      }
    }
    if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) {
      const named = resolveRef?.(node.$ref);
      const name = parseCanonicalTypeSchemaId(node.$ref)?.typeName ?? node.$ref;
      if (named) visit(named, named, path, shape ?? name, shape ? inner : []);
    }
  };
  visit(schema, schema, at, undefined, []);
  return problems;
}

/**
 * A text judged against the values its reader declares it is formatted with:
 * every placeholder and selector must be one of them (`MESSAGE_PLACEHOLDER_UNBOUND`)
 * and a selector must be a number (`MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED`).
 */
export function judgeDeclaredValues(
  message: Parameters<typeof judgeValues>[0],
  declared: Readonly<Record<string, unknown>>,
): TextProblem[] {
  const names = Object.keys(declared);
  const advice =
    names.length === 0
      ? "whoever shows this text formats it with no values — write it without placeholders"
      : `whoever shows this text formats it with ${names.map((name) => `{$${name}}`).join(", ")} — write only those placeholders`;
  return judgeValues(message, declaredValueKinds(declared)).map((problem) =>
    problem.code === "MESSAGE_PLACEHOLDER_UNBOUND" ? { ...problem, message: `${problem.message}, but ${advice}` } : problem,
  );
}
