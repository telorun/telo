import type { JsonSchema } from "./model-schema.js";

/**
 * A page's path read as segments: each one literal, or exactly `{name}` — a
 * variable standing for one non-empty segment, read in the browser as
 * `params.<name>`. The page's schema refuses any other brace and a repeated
 * name, so this reader assumes a valid path.
 */

const VARIABLE = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** The names of a page path's variables, in path order. */
export function pagePathVariables(path: string): string[] {
  return path
    .split("/")
    .map((segment) => VARIABLE.exec(segment)?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * The addresses a page path routes, as one key: the path with each variable
 * erased to `{}`. Two pages whose keys are equal route the same addresses,
 * whatever their variables are named.
 */
export function pageRouteKey(path: string): string {
  return path
    .split("/")
    .map((segment) => (VARIABLE.test(segment) ? "{}" : segment))
    .join("/");
}

/** `params` where the page placing a composite is not known: its variables, each a string. */
export const PAGE_PARAMS: JsonSchema = { type: "object", additionalProperties: { type: "string" } };
