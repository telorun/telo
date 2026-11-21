import { canonicalTypeSchemaId, type ResourceContext } from "@telorun/sdk";
import type { SpecNode } from "./composite.js";
import { modelShape, type ShapeReader } from "./model-schema.js";
import type { AuthoredNode, RootShapes } from "./node-resolution.js";
import { PAGE_PARAMS } from "./page-path.js";
import { isQuery, type QuerySpec } from "./query-controller.js";
import { DEFAULT_FAILURE } from "./request-failure.js";
import { uiText } from "./spec-texts.js";

/** The three node lists a `query` node holds, in the order they are resolved. */
export const QUERY_LISTS = ["content", "loading", "failure"] as const;
export type QueryList = (typeof QUERY_LISTS)[number];

/** What `loading` is when the author leaves it out. */
export const DEFAULT_LOADING: SpecNode = { type: "text", text: uiText("loading"), style: "muted" };

/** The spec of the query a `query` node's slot holds. */
export function queryOf(value: unknown, ctx: ResourceContext, where: string): QuerySpec {
  return ctx.resolveRef(value, isQuery, () => `'query' of the query node at ${where}`, "Ui.Query").spec();
}

/** A list as written, or what `ui` fills in when the author left it out. */
export function queryListOf(node: { [key: string]: unknown }, list: QueryList): AuthoredNode[] {
  const written = node[list] as AuthoredNode[] | null | undefined;
  if (written != null) return written;
  if (list === "loading") return [DEFAULT_LOADING as AuthoredNode];
  return list === "failure" ? [DEFAULT_FAILURE] : [];
}

/**
 * What the roots a list of a `query` node reads say about the values they
 * name: `data` in `content`, `error` in `failure`, the query's own `query` in
 * all three, and the placing page's `params` as the enclosing tree has them.
 */
export function queryListRoots(spec: QuerySpec, list: QueryList, outer: RootShapes, reader: ShapeReader): RootShapes {
  const query = modelShape({ type: "object", properties: spec.query, additionalProperties: false }, reader, "query");
  const params = outer.params ?? modelShape(PAGE_PARAMS, reader, "params");
  if (list === "content") return { data: modelShape(spec.schema, reader, "model"), query, params };
  if (list === "loading") return { query, params };
  return { error: modelShape({ $ref: canonicalTypeSchemaId("Ui", "RequestError") }, reader, "failure"), query, params };
}
