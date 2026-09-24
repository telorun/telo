/**
 * The shape of a `throws:` block and which capabilities may declare one — read
 * by `telo check` (the built-in `Telo.Definition` / `Telo.Abstract` schemas and
 * `validate-throws-coverage.ts`) and by the kernel's definition schemas, so the
 * two halves cannot disagree about what a manifest may write.
 */

const THROW_CODES_SCHEMA = {
  type: "object",
  propertyNames: { pattern: "^[A-Z][A-Z0-9_]*$" },
  additionalProperties: {
    type: "object",
    required: ["description"],
    additionalProperties: false,
    properties: {
      description: { type: "string" },
      data: { type: "object", additionalProperties: true },
    },
  },
};

/** A definition's `throws:`: a literal list, or a union derived per instance. */
export const THROWS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    codes: THROW_CODES_SCHEMA,
    // The union of what the kind dispatches, minus what it catches.
    inherit: { type: "boolean" },
    // Whatever the call site's `inputs.code` resolves to.
    passthrough: { type: "boolean" },
  },
};

/** An abstract's `throws:`: the ceiling its implementations' codes fall within.
 *  A literal list only — an abstract has no body for a union to come from. */
export const ABSTRACT_THROWS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { codes: THROW_CODES_SCHEMA },
};

/** Rule 8: a throw union describes what a CALLER can catch, so only a capability
 *  whose dispatch returns to a caller may declare one. An allowlist, so a
 *  capability nothing knows (a third party's, `Telo.Executable`) is refused by
 *  both halves alike. */
export const THROWS_CAPABLE_CAPABILITIES: readonly string[] = ["Telo.Invocable", "Telo.Runnable"];
