import type { TemplatingEngine } from "../engine.js";

/** The `!ref` engine. Marks a tagged scalar as a resource reference: the
 *  source is the bare resource name, looked up against the slot's
 *  `x-telo-ref` constraint by the analyzer and the kernel.
 *
 *  Returns the source string verbatim at compile time. The actual lookup
 *  (sentinel → live ResourceInstance) happens at resource-context init,
 *  not at templating-engine compile — the engine just preserves the source
 *  through the parse/serialize round-trip. Analysis is a no-op; reference
 *  resolution is the analyzer's responsibility via the ref-aware walker. */
export const refEngine: TemplatingEngine = {
  name: "ref",

  compile(source) {
    return source;
  },

  analyze() {
    return [];
  },
};
