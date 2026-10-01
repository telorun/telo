/**
 * Whether a JSON Schema admits `null`, read two ways — as what a PRODUCER may
 * yield and as what a SLOT accepts.
 *
 * A null reaching a slot that does not take one is refused at dispatch whatever
 * the non-null half of the producer's type is, and no CEL type says so: cel-js
 * types a nullable object as the object. So the question is asked of the two
 * schemas. Each side is read in the direction that keeps the check silent where
 * it knows least: a producer admits null only where it SAYS so, and a slot
 * refuses null only where it declares a type that leaves null out.
 */

import { unionBranches } from "./schema-compat.js";

/** True when `schema` declares that its value may be null. */
export function producerAdmitsNull(schema: Record<string, any>): boolean {
  const type = schema.type;
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) return true;
  if (schema.nullable === true) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  if ("const" in schema && schema.const === null) return true;
  return unionBranches(schema)?.some(producerAdmitsNull) ?? false;
}

/** True when a null would satisfy `schema` as a slot: it says so, it declares
 *  no type at all, or one of its union's branches does either. */
export function slotAdmitsNull(schema: Record<string, any>): boolean {
  if (producerAdmitsNull(schema)) return true;
  const branches = unionBranches(schema);
  if (branches) return branches.some(slotAdmitsNull);
  return schema.type === undefined;
}
