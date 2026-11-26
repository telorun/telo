/**
 * The names a kind's CEL contexts declare, over every configuration at once:
 * each binding an `x-telo-context` region in force anywhere in the kind's
 * schema puts in scope, with the condition it holds under.
 *
 * The kind's own regions hold in every configuration. A region inside a named
 * shape the schema reaches is read once per class of that shape's content, its
 * own named references stood in, and each of its names holds where that class
 * is reached (`NamedShapeReader.reach`) — so a shape varying under a choice
 * labels only the names it declares.
 *
 * A shape of a library imported more than once is read as the classes of
 * every instance (`NamedShapeReader.classes`), never one instance's: a kind
 * document is one document for every instance of its module, so what it finds
 * through a shape holds where some instance reads that class.
 *
 * Browser-safe.
 */
import type { NamedShapeLookup } from "./eval-paths.js";
import { nodeAtPointer, type NamedShapeReader } from "./named-shape-reader.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import { extractContextsFromSchema } from "./validate-cel-context.js";

type Schema = Record<string, any>;

/** One name a kind's contexts declare, and where. */
export interface ContextName {
  readonly name: string;
  readonly condition: Condition;
}

/** The names the context regions of `schema` declare, its named shapes stood in. */
function regionNames(schema: Schema, lookup: NamedShapeLookup): string[] {
  const names = new Set<string>();
  for (const { schema: context } of extractContextsFromSchema(schema, lookup)) {
    for (const name of Object.keys(context.properties ?? {})) names.add(name);
  }
  return [...names];
}

/**
 * Every name the contexts of a kind's `schema` declare. `kindSchemaOf` answers
 * a reference to a kind's own schema, which never varies.
 */
export function kindContextNames(
  schema: Schema,
  shapes: NamedShapeReader,
  kindSchemaOf: NamedShapeLookup,
): ContextName[] {
  const { space } = shapes;
  const lookup: NamedShapeLookup = (id) => (shapes.isShapeId(id) ? undefined : kindSchemaOf(id));
  const held = new Map<string, Condition>();
  const hold = (name: string, condition: Condition) => held.set(name, space.or(held.get(name) ?? FALSE, condition));
  for (const name of regionNames(schema, lookup)) hold(name, TRUE);
  for (const pair of shapes.reach(shapes.edges(schema))) {
    for (const shape of shapes.classes(pair.target)) {
      const at = nodeAtPointer(shape.schema, pair.pointer);
      if (!at || typeof at !== "object") continue;
      const names = shapes.verdict(`contextNames${pair.pointer}`, shape, () => regionNames(at as Schema, lookup));
      const condition = space.and(pair.condition, shape.condition);
      for (const name of names) hold(name, condition);
    }
  }
  return [...held].map(([name, condition]) => ({ name, condition }));
}
