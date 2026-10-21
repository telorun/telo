import type { SpecNode } from "./composite.js";
import type { AuthoredNode } from "./node-resolution.js";

/** What a `failure` tree is when the author leaves it out: the error's code
 *  and message. */
export const DEFAULT_FAILURE: AuthoredNode = {
  type: "stack",
  style: "danger",
  children: [
    { type: "value", value: { root: "error", path: ["code"] }, style: "strong" },
    { type: "value", value: { root: "error", path: ["message"] } },
  ],
};

/** A node tree that resolved to nothing still occupies its place. */
export const NOTHING: SpecNode = { type: "stack", children: [] };
