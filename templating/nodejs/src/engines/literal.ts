import type { TemplatingEngine } from "../engine.js";

/** The `!literal` engine. Treats the tagged scalar as opaque text — no CEL
 *  interpolation, no analysis. Returns the source string verbatim at compile
 *  time so the runtime sees a plain string. */
export const literalEngine: TemplatingEngine = {
  name: "literal",

  compile(source) {
    return source;
  },

  analyze() {
    return [];
  },
};
