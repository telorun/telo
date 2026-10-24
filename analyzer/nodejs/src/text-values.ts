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
import {
  judgeValues,
  schemaValueKind,
  type KnownValues,
  type MessageValueKind,
  type TextProblem,
} from "./text-judgement.js";
import {
  pointerSegments,
  relativePointerOf,
  renderValuePath,
  TEXT_VALUES_ANNOTATION,
  TEXT_VALUES_FOR_ANNOTATION,
  TEXT_VALUES_FROM_ANNOTATION,
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
 * Every misplaced `x-telo-text-values` / `x-telo-text-values-from` a kind's
 * schema reaches — through properties, map values, list items, unions,
 * document-local references and named shapes: not on a `Text` / `Message` node, a
 * declared value whose schema is neither a string nor a number, a text a values
 * pairing already binds, a values-from that is no relative pointer, sits beside a
 * declared value map, or names a sibling the holding object does not declare.
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
  const report = (
    path: ValuePath,
    shape: string | undefined,
    inner: ValuePath,
    reason: string,
    annotation: string = TEXT_VALUES_ANNOTATION,
  ) => {
    const where = renderValuePath(shape ? path : [...path, annotation]);
    const place = shape
      ? `'${where}', which reaches '${renderValuePath([...inner, annotation])}' in the named shape '${shape}' it names,`
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
    if (TEXT_VALUES_FROM_ANNOTATION in node) {
      const fragment = fragmentAt(node, root, resolveRef);
      const from = (why: string) => report(path, shape, inner, why, TEXT_VALUES_FROM_ANNOTATION);
      if (fragment !== "Text" && fragment !== "Message") {
        from("on a node that is no text: it names the schema whose required properties a Text or a Message is formatted with, so write it beside the text's `$ref: telo://manifest#/$defs/Text`.");
      } else if (!relativePointerOf(node[TEXT_VALUES_FROM_ANNOTATION])) {
        from("as something other than a relative JSON pointer (`0/data` names the sibling `data`).");
      } else if (TEXT_VALUES_ANNOTATION in node) {
        from(`beside ${TEXT_VALUES_ANNOTATION}: a text's values are declared one way. Remove one of the two.`);
      }
    }
    if (isSchema(node.properties)) {
      // A text naming a sibling for its values must name one this object declares.
      for (const [key, child] of Object.entries(node.properties)) {
        const relative = relativePointerOf(isSchema(child) ? child[TEXT_VALUES_FROM_ANNOTATION] : undefined);
        if (!relative || relative.up !== 0 || relative.segments.length === 0) continue;
        if (!Object.hasOwn(node.properties, relative.segments[0]!)) {
          const [p, i] = step(["properties", key]);
          report(p, shape, i, `naming '${relative.segments[0]}', which the object holding the text does not declare.`, TEXT_VALUES_FROM_ANNOTATION);
        }
      }
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

/** What a property schema admits as a message value, read strictly: only a
 *  value DECLARED a string or a number can fill a placeholder, so one of no
 *  declared type is refused rather than trusted. */
function dataValueKind(schema: unknown): { kind: MessageValueKind; describe: string } {
  const type = isSchema(schema) ? schema.type : undefined;
  const types = (Array.isArray(type) ? type : type === undefined ? [] : [type]) as unknown[];
  if (types.length === 0) return { kind: "refused", describe: "a value of no declared type" };
  if (types.every((t) => t === "string")) return { kind: "string", describe: "a string" };
  if (types.every((t) => t === "integer" || t === "number")) return { kind: "number", describe: "a number" };
  if (types.every((t) => t === "string" || t === "integer" || t === "number")) {
    return { kind: "string", describe: "a string or a number" };
  }
  return { kind: "refused", describe: `a value declared ${types.join(" or ")}` };
}

/** The values a text naming `x-telo-text-values-from` is formatted with: each
 *  REQUIRED property of the data schema, as what it is declared to be. A
 *  property the data may lack is no value, since an error may arrive without it. */
export function dataTextValues(schema: unknown): KnownValues {
  if (!isSchema(schema)) return new Map();
  const properties = isSchema(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((n): n is string => typeof n === "string") : [];
  return new Map(required.map((name) => [name, dataValueKind(properties[name])]));
}

/** A text judged against the values its sibling data schema guarantees. */
export function judgeDataValues(
  message: Parameters<typeof judgeValues>[0],
  schema: unknown,
  dataPath: ValuePath,
): TextProblem[] {
  const known = dataTextValues(schema);
  const names = [...known.keys()];
  const advice =
    `this text is formatted with the required properties of '${renderValuePath(dataPath)}'` +
    (names.length === 0 ? ", which declares none" : `: ${names.map((name) => `{$${name}}`).join(", ")}`) +
    " — name only those, or declare the property and list it under required";
  return judgeValues(message, known).map((problem) =>
    problem.code === "MESSAGE_PLACEHOLDER_UNBOUND" ? { ...problem, message: `${problem.message}, but ${advice}` } : problem,
  );
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
