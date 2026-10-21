import { createContext, useContext } from "react";
import { isRecord } from "../../lib/utils";
import { resolveRef } from "../../schema-utils";
import type { JsonSchemaProperty } from "./types";

/**
 * The schema a form was given, which is what a document-local `$ref`
 * (`#/$defs/…`) inside it resolves against. A recursive shape reaches itself
 * this way, so it can only be followed one node at a time, as each field
 * renders. Absent outside a form: nothing is resolved there.
 */
export const LocalSchemaRoot = createContext<Record<string, unknown> | undefined>(undefined);

export function useLocalSchemaRoot(): Record<string, unknown> | undefined {
  return useContext(LocalSchemaRoot);
}

/**
 * The node a document-local `$ref` names, with whatever the referring node
 * declares beside it (a title, a description, a stamp) laid over it. A node
 * holding no such reference, or one that does not resolve, is returned as is.
 */
export function resolveLocalSchemaRef(
  prop: JsonSchemaProperty,
  root: Record<string, unknown> | undefined,
): JsonSchemaProperty {
  if (!root) return prop;
  let node: JsonSchemaProperty = prop;
  const seen = new Set<string>();
  while (typeof node.$ref === "string" && node.$ref.startsWith("#/") && !seen.has(node.$ref)) {
    seen.add(node.$ref);
    const target = resolveRef(node, root);
    if (!isRecord(target)) return node;
    const beside = Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$ref"));
    node = { ...(target as JsonSchemaProperty), ...beside };
  }
  return node;
}
