import type { TemplatingEngine } from "../engine.js";

/** The `!literal` engine. Treats the tagged scalar as opaque text — no CEL
 *  interpolation, no analysis. Returns the source string verbatim at compile
 *  time so the runtime sees a plain string. */
export const literalEngine: TemplatingEngine = {
  name: "literal",

  compile(source) {
    return source;
  },

  /**
   * Opaque text is TEXT — the type is a constant of the tag, exactly as an
   * embed's is, not a function of the slot.
   *
   * Declaring nothing put `!literal` in the other category, the one `!cel` and
   * `!ref` belong to, and everything downstream then treated it as producing
   * whatever the slot asked for. So the editor offered it at a boolean
   * predicate — where opaque text cannot satisfy the slot and `Run.Choice` has
   * a runtime error saying so — and the analyzer type-checked one against a
   * slot-shaped placeholder instead of the string it will actually be.
   */
  producedType() {
    return { type: "string" };
  },

  analyze() {
    return { diagnostics: [], calls: [] };
  },
};
