/**
 * A text slot at or beneath an accessor field — the one reader of
 * `TEXT_SLOT_ACCESSOR` (static, at the kind; at the `imports:` entry for a
 * dependency's) and `ERR_TEXT_SLOT_ACCESSOR` (the kernel, when it registers the
 * definition).
 *
 * An `x-telo-eval: accessor` field is never evaluated: its controller receives a
 * binding (`{ root, path }` / `{ value }`). A `Message`, `Text` or `TextCatalog`
 * there could be neither judged in its writer's language nor handed over as its
 * record, while `telo check` would judge the literal written there — so the kind
 * is refused instead. The accessor fields are found by the walk the eval-path
 * reader makes (`eval-paths.ts`); beneath one, the search follows document-local
 * references and named shapes.
 *
 * Browser-safe: no Node built-ins.
 */
import { parseCanonicalTypeSchemaId } from "@telorun/sdk";
import { declaredEvalMode } from "./eval-paths.js";
import { resolveSchemaReference, schemaReferenceParts } from "./schema-reference.js";
import { pointerSegments, renderValuePath, textFragmentOf, type TextFragment, type ValuePath } from "./text-slot.js";

export interface TextSlotAccessorProblem {
  /** Where the field's `x-telo-eval: accessor` is written, from the kind document. */
  readonly path: string;
  readonly message: string;
}

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema =>
  !!node && typeof node === "object" && !Array.isArray(node);

/** The keys whose values are schemas of what the value holds beneath a node. */
function childSchemas(node: Schema): Schema[] {
  const out: Schema[] = [];
  for (const map of [node.properties, node.patternProperties]) {
    if (isSchema(map)) out.push(...Object.values(map).filter(isSchema));
  }
  if (isSchema(node.additionalProperties)) out.push(node.additionalProperties);
  if (isSchema(node.items)) out.push(node.items);
  else if (Array.isArray(node.items)) out.push(...node.items.filter(isSchema));
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(node[key])) out.push(...node[key].filter(isSchema));
  }
  for (const key of ["then", "else"] as const) if (isSchema(node[key])) out.push(node[key]);
  return out;
}

interface TextBeneath {
  readonly fragment: TextFragment;
  /** The named shape the text was reached through, when it was. */
  readonly shape?: string;
}

/** A walk that stops at a reference `stops` answers, naming it to `met`. */
export interface TextSlotAccessorStop {
  stops(ref: string): boolean;
  met(ref: string, path: ValuePath): void;
}

function textBeneath(
  node: Schema,
  root: Schema,
  resolveRef: ((ref: string) => Schema | undefined) | undefined,
  seen: Set<object>,
  shape: string | undefined,
  stop?: { stops(ref: string): boolean; met: string[] },
): TextBeneath | undefined {
  if (seen.has(node)) return undefined;
  seen.add(node);
  const fragment = textFragmentOf(node);
  if (fragment !== undefined) return { fragment, ...(shape ? { shape } : {}) };
  if (typeof node.$ref === "string") {
    if (stop?.stops(node.$ref)) stop.met.push(node.$ref);
    else {
      const target = resolveSchemaReference(node.$ref, root, resolveRef);
      const name = target?.shape ? (parseCanonicalTypeSchemaId(target.shape)?.typeName ?? target.shape) : undefined;
      const found = target ? textBeneath(target.node, target.document, resolveRef, seen, shape ?? name, stop) : undefined;
      if (found) return found;
    }
  }
  for (const child of childSchemas(node)) {
    const found = textBeneath(child, root, resolveRef, seen, shape, stop);
    if (found) return found;
  }
  return undefined;
}

/** The text a node is typed by, at or beneath it, never crossing a reference
 *  `stops` answers — or the named-shape references it stopped at. */
export function textBeneathNode(
  node: Schema,
  root: Schema,
  resolveRef: ((ref: string) => Schema | undefined) | undefined,
  stops: (ref: string) => boolean,
): { readonly found?: TextBeneath; readonly met: readonly string[] } {
  const met: string[] = [];
  const found = textBeneath(node, root, resolveRef, new Set(), undefined, { stops, met });
  return found ? { found, met } : { met };
}

/** One accessor field a walk found typed by a text, or whose text is decided
 *  in the named shapes `beneath` names: where it is reported (`path`), the
 *  named shape and the place in it when it is inside one. */
export interface TextSlotAccessorEntry {
  readonly path: ValuePath;
  readonly shape?: { readonly name: string; readonly inner: ValuePath };
  readonly found?: TextBeneath;
  /** The named-shape references beneath the accessor, where no text is. */
  readonly beneath?: readonly string[];
}

/** An entry's finding, reported at `path` of the kind `kind`, its text `found`. */
export function textSlotAccessorProblemOf(
  kind: string,
  entry: TextSlotAccessorEntry,
  found: TextBeneath,
  path: ValuePath = entry.path,
): TextSlotAccessorProblem {
  const { shape } = entry;
  const where = renderValuePath(shape ? path : [...path, "x-telo-eval"]);
  const field = shape
    ? `'${renderValuePath([...shape.inner, "x-telo-eval"])}: accessor' in the named shape '${shape.name}' it names`
    : `'${where}: accessor'`;
  const through = found.shape && found.shape !== shape?.name ? ` through the named shape '${found.shape}'` : "";
  return {
    path: where,
    message:
      `'${kind}' declares ${shape ? `'${where}', which reaches ` : ""}${field}, and the field's value is typed by the ${found.fragment} ` +
      `fragment${through}. An accessor field is never evaluated — its controller receives a ` +
      `binding — so a text there can be neither judged in the language of the module that ` +
      `wrote it nor handed over as its record. Give the text a field of its own, or type ` +
      `the accessor's value as plain data.`,
  };
}

/**
 * Every accessor field of a kind whose value is typed, at or beneath the field,
 * by a text fragment. `schema` is the kind's configuration schema, `at` where it
 * is written in the kind document; `resolveRef` resolves a named shape.
 */
export function textSlotAccessorProblems(
  kind: string,
  schema: unknown,
  resolveRef?: (ref: string) => Schema | undefined,
  at: ValuePath = ["schema"],
): TextSlotAccessorProblem[] {
  if (!isSchema(schema) || !isSchema(schema.properties)) return [];
  return walkTextSlotAccessors({ schema, at }, resolveRef).flatMap((entry) =>
    entry.found ? [textSlotAccessorProblemOf(kind, entry, entry.found)] : [],
  );
}

/** Where a walk starts: the kind's `schema` written at `at`, or a node inside
 *  a named shape's `document`, at `inner` in it, reported at `path`. */
export type TextSlotAccessorStart =
  | { readonly schema: Schema; readonly at: ValuePath }
  | { readonly node: Schema; readonly path: ValuePath; readonly shape: { readonly name: string; readonly document: Schema; readonly inner: ValuePath } };

/** The walk {@link textSlotAccessorProblems} makes, from `start`; a reference
 *  `stop` answers is not followed. */
export function walkTextSlotAccessors(
  start: TextSlotAccessorStart,
  resolveRef?: (ref: string) => Schema | undefined,
  stop?: TextSlotAccessorStop,
): TextSlotAccessorEntry[] {
  const schema = "schema" in start ? start.schema : start.shape.document;
  const at = "schema" in start ? start.at : start.path;
  const problems: TextSlotAccessorEntry[] = [];
  const judged = new Set<object>();
  /** Where the walk is inside a named shape: the shape, and the place in it.
   *  A finding there is reported at the kind's field naming the shape. */
  interface InShape {
    readonly name: string;
    readonly document: Schema;
    readonly inner: ValuePath;
  }
  const visit = (node: unknown, path: ValuePath, open: readonly object[], shape?: InShape): void => {
    if (!isSchema(node)) return;
    const mode = declaredEvalMode(node);
    if (mode) {
      if (mode !== "accessor" || judged.has(node)) return;
      judged.add(node);
      const met: string[] = [];
      const found = textBeneath(node, shape?.document ?? schema, resolveRef, new Set(), shape?.name, stop && { stops: stop.stops, met });
      if (!found && met.length === 0) return;
      problems.push({
        path,
        ...(shape ? { shape: { name: shape.name, inner: shape.inner } } : {}),
        ...(found ? { found } : { beneath: met }),
      });
      return;
    }
    const step = (key: ValuePath): [ValuePath, InShape | undefined] =>
      shape ? [path, { ...shape, inner: [...shape.inner, ...key] }] : [[...path, ...key], undefined];
    if (typeof node.$ref === "string") {
      if (stop?.stops(node.$ref)) {
        stop.met(node.$ref, path);
        return;
      }
      const document = shape?.document ?? schema;
      const reached = resolveSchemaReference(node.$ref, document, resolveRef);
      if (!reached || open.includes(reached.node)) return;
      const target = reached.node;
      const segments = pointerSegments(schemaReferenceParts(node.$ref).pointer.slice(1)) ?? [];
      if (reached.shape === undefined) {
        if (shape) visit(target, path, [...open, target], { ...shape, inner: segments });
        else visit(target, [...at, ...segments], [...open, target]);
      } else {
        const name = parseCanonicalTypeSchemaId(reached.shape)?.typeName ?? reached.shape;
        visit(target, path, [...open, target], { name, document: reached.document, inner: segments });
      }
      return;
    }
    if (isSchema(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        const [p, s] = step(["properties", key]);
        visit(child, p, open, s);
      }
    }
    if (isSchema(node.patternProperties)) {
      for (const [key, child] of Object.entries(node.patternProperties)) {
        const [p, s] = step(["patternProperties", key]);
        visit(child, p, open, s);
      }
    }
    if (isSchema(node.additionalProperties)) {
      const [p, s] = step(["additionalProperties"]);
      visit(node.additionalProperties, p, open, s);
    }
    if (isSchema(node.items)) {
      const [p, s] = step(["items"]);
      visit(node.items, p, open, s);
    }
    for (const key of ["oneOf", "anyOf", "allOf"] as const) {
      if (Array.isArray(node[key])) {
        node[key].forEach((branch: unknown, i: number) => {
          const [p, s] = step([key, i]);
          visit(branch, p, open, s);
        });
      }
    }
  };
  if ("schema" in start) {
    if (isSchema(schema.properties)) {
      for (const [key, child] of Object.entries(schema.properties)) visit(child, [...at, "properties", key], []);
    }
  } else visit(start.node, start.path, [start.node], start.shape);
  return problems;
}
