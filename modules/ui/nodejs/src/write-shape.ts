import { RuntimeError } from "@telorun/sdk";
import type { CollectionFacts } from "./collection-source.js";
import { plainTypes, type JsonSchema } from "./model-schema.js";

/** Whether a record of `have` fits where the write shape declares `want`. */
const typeFits = (have: string[], want: string[]): boolean =>
  have.every((type) => want.includes(type) || (type === "integer" && want.includes("number")));

/**
 * What a form refuses of the collection's write shapes: the one its write goes
 * to must be declared, and the model may hold no property it does not declare
 * or declares with another type. The twin of the `UI_WRITE_*` rules on `Ui.Form`.
 */
export function assertWriteShape(model: JsonSchema, collection: CollectionFacts, edits: boolean, owner: string): void {
  const name = edits ? "update" : "create";
  const shape = collection.schemas[name];
  if (!shape) {
    throw new RuntimeError(
      "ERR_UI_WRITE_UNDECLARED",
      `${owner}: 'record' names a collection that declares no 'schemas.${name}', which a form ${edits ? "with" : "without"} 'record.key' writes through. Declare it under the collection's 'schemas', or ${edits ? "remove 'record.key'" : "give the form 'record.key'"}.`,
    );
  }
  const written = (shape.properties ?? {}) as Record<string, JsonSchema>;
  if (shape.properties === undefined) return;
  for (const [property, declared] of Object.entries((model.properties ?? {}) as Record<string, JsonSchema>)) {
    const target = written[property];
    if (target === undefined) {
      throw new RuntimeError(
        "ERR_UI_WRITE_SHAPE_MISMATCH",
        `${owner}: 'model' declares '${property}', which the collection's 'schemas.${name}' does not declare. Remove it from the model, or declare it in that shape.`,
      );
    }
    const have = plainTypes(declared);
    const want = plainTypes(target);
    if (have.length > 0 && want.length > 0 && !typeFits(have, want)) {
      throw new RuntimeError(
        "ERR_UI_WRITE_SHAPE_MISMATCH",
        `${owner}: 'model' declares '${property}' as ${have.join(" | ")}, which the collection's 'schemas.${name}' declares as ${want.join(" | ")}. Use the type that shape declares.`,
      );
    }
  }
}
