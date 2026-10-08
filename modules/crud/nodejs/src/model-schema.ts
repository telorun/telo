import { RuntimeError, type ResourceContext } from "@telorun/sdk";
import type { JsonSchema } from "./model-properties.js";

// The same reading as `modelSchema` in modules/ui/nodejs/src/model-schema.ts; keep the two alike.
/** The JSON Schema a shape slot names — a live shape, a reference the registry
 *  holds, or a schema written in place. */
export function modelSchema(model: unknown, ctx: ResourceContext, owner: string, slot = "model"): JsonSchema {
  if (model && typeof model === "object") {
    const value = model as Record<string, any>;
    if (value.schema && typeof value.schema === "object") return value.schema;
    const key = typeof value.$ref === "string" ? value.$ref : value.name;
    if (typeof key === "string") {
      const found = ctx.lookupSchema(key);
      if (found) return found as JsonSchema;
    } else if (value.type || value.properties) {
      return value;
    }
  }
  throw new RuntimeError("ERR_REF_UNRESOLVED", `${owner}: '${slot}' does not name a data shape.`);
}
