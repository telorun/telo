import { validate, type JsonSchema } from "./validation.js";

/**
 * The `query` root of a page or a reader: each declared parameter the address
 * holds, read as its declaration says — a list for a list parameter, one value
 * for a scalar. A parameter the address leaves out, a scalar given more than
 * once, or a value its declaration refuses is absent.
 */
export function queryRoot(declared: Record<string, JsonSchema> | undefined, search: string): Record<string, unknown> {
  const params = new URLSearchParams(search);
  const root: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(declared ?? {})) {
    const given = params.getAll(name);
    if (given.length === 0) continue;
    const value = schema.type === "array" ? given : given.length === 1 ? given[0] : undefined;
    if (value !== undefined && validate(schema, value).length === 0) root[name] = value;
  }
  return root;
}
