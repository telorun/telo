/**
 * The JSON Schema vocabulary an author writes inside a manifest, as data.
 *
 * WHY THIS EXISTS. A schema-valued slot used to be declared `type: object` and
 * nothing more, so every surface that reads a kind schema — completion, hover,
 * the editor's field walk, AJV — knew only "some object". Autocompletion was
 * dead from the first key, and a typo (`requred:`, `type: 5`) was carried all
 * the way to a runtime validation failure that named the wrong thing.
 *
 * ONE SOURCE, TWO SURFACES. The maps below are the whole vocabulary; the
 * fragments in `manifest-schemas.ts` are built FROM them, and completion reads
 * them directly. A second hand-written list is exactly how the IDE's suggestions
 * and the validator's rules would drift apart.
 *
 * WHY THE ANNOTATIONS ARE NOT IN THE VALIDATING FRAGMENT. `x-telo-*` keys are
 * offered by completion but deliberately never appear as literal property names
 * in the schema that gets hoisted into a manifest. Several passes walk a
 * definition's schema testing every object for an annotation KEY
 * (`resolveSchemaRefKinds`, `validate-ref-slots`, `validate-zone-slots`), and a
 * `properties` map holding a key spelled `x-telo-ref` reads to them as an
 * annotated node — inventing diagnostics about a slot the author never wrote.
 * So the hoisted body stays open (`additionalProperties: true`, which admits
 * every annotation) and the annotation vocabulary stays here, on the analyzer
 * side of the boundary, where no manifest walk can reach it.
 *
 * Browser-safe: no Node built-ins.
 */

import { X_TELO_TYPE } from "@telorun/sdk";

/** The one annotation read from a DATA schema rather than a kind schema. */
const X_TELO_SENSITIVE = "x-telo-sensitive" as const;
import { ANNOTATION_KEYWORDS } from "./value-type-keyword.js";

/** A keyword entry: the JSON Schema its VALUE must satisfy, carrying the title
 *  and description completion and hover show. */
export type SchemaKeywords = Record<string, Record<string, unknown>>;

/** A JSON type name, as `type:` accepts it — one, or a list (`[string, "null"]`,
 *  the spelling `CEL_NULLABLE_ACCESS` guards). */
const TYPE_NAME = {
  type: "string",
  enum: ["object", "array", "string", "number", "integer", "boolean", "null"],
};

/**
 * The draft-07 keywords, as a property map for a fragment named `self`.
 *
 * Parameterized by the fragment name because a schema's nested positions hold
 * schemas of the SAME flavour: a property of a kind schema may carry
 * annotations, a property of a data schema may not. Both recurse into
 * themselves, and the document-local pointer is what the hoisting in
 * `expandManifestFragments` makes resolvable.
 */
export function jsonSchemaKeywords(self: string): SchemaKeywords {
  const schema = { $ref: `#/$defs/${self}` };
  const schemaList = { type: "array", items: schema };

  return {
    // Shape
    type: {
      title: "Type",
      description: "The JSON type this value must have, or a list of accepted types.",
      anyOf: [TYPE_NAME, { type: "array", items: TYPE_NAME }],
    },
    properties: {
      title: "Properties",
      description: "Schema per named property of an object.",
      type: "object",
      additionalProperties: schema,
    },
    required: {
      title: "Required",
      description: "Property names that must be present.",
      type: "array",
      items: { type: "string" },
    },
    additionalProperties: {
      title: "Additional properties",
      description:
        "`false` rejects any property not named above — which is what makes a typo an error rather than an ignored field.",
      anyOf: [{ type: "boolean" }, schema],
    },
    patternProperties: {
      title: "Pattern properties",
      description: "Schema per regular expression matching a property name.",
      type: "object",
      additionalProperties: schema,
    },
    propertyNames: {
      title: "Property names",
      description: "Schema every property NAME must satisfy.",
      ...schema,
    },
    items: {
      title: "Items",
      description: "Schema for each element of an array.",
      anyOf: [schema, schemaList],
    },
    additionalItems: {
      title: "Additional items",
      description: "Schema for elements past a positional `items` list.",
      anyOf: [{ type: "boolean" }, schema],
    },
    contains: {
      title: "Contains",
      description: "At least one element must satisfy this schema.",
      ...schema,
    },

    // Composition
    allOf: { title: "All of", description: "Every branch must match.", ...schemaList },
    anyOf: { title: "Any of", description: "At least one branch must match.", ...schemaList },
    oneOf: {
      title: "One of",
      description:
        "Exactly one branch must match. Prefer `anyOf` when a branch declares a value type — a consumer that does not know the keyword reads the branch as matching everything, and only `anyOf` degrades gracefully.",
      ...schemaList,
    },
    not: { title: "Not", description: "The value must NOT match this schema.", ...schema },
    if: { title: "If", description: "Condition selecting `then` / `else`.", ...schema },
    then: { title: "Then", description: "Applied when `if` matches.", ...schema },
    else: { title: "Else", description: "Applied when `if` does not match.", ...schema },

    // Values
    enum: { title: "Enum", description: "The complete set of accepted values.", type: "array" },
    const: { title: "Const", description: "The single accepted value." },
    default: {
      title: "Default",
      description:
        "Filled in when the value is absent. On an invocation contract this is applied at dispatch, so a caller may omit the field.",
    },
    examples: { title: "Examples", description: "Sample values, for documentation.", type: "array" },

    // Numbers
    minimum: { title: "Minimum", type: "number" },
    maximum: { title: "Maximum", type: "number" },
    exclusiveMinimum: { title: "Exclusive minimum", type: "number" },
    exclusiveMaximum: { title: "Exclusive maximum", type: "number" },
    multipleOf: { title: "Multiple of", type: "number", exclusiveMinimum: 0 },

    // Strings
    minLength: { title: "Min length", type: "integer", minimum: 0 },
    maxLength: { title: "Max length", type: "integer", minimum: 0 },
    pattern: { title: "Pattern", description: "Regular expression the string must match.", type: "string" },
    format: {
      title: "Format",
      description: "Named string format (`date-time`, `uri`, `email`, …).",
      type: "string",
    },
    contentMediaType: {
      title: "Content media type",
      description:
        "Media type of the string's content (`application/javascript`). Drives the editor's code-widget language.",
      type: "string",
    },
    contentEncoding: { title: "Content encoding", type: "string" },

    // Arrays
    minItems: { title: "Min items", type: "integer", minimum: 0 },
    maxItems: { title: "Max items", type: "integer", minimum: 0 },
    uniqueItems: { title: "Unique items", type: "boolean" },

    // Objects
    minProperties: { title: "Min properties", type: "integer", minimum: 0 },
    maxProperties: { title: "Max properties", type: "integer", minimum: 0 },
    dependencies: {
      title: "Dependencies",
      description: "Per property, the other properties it requires — or a schema to apply.",
      type: "object",
      additionalProperties: { anyOf: [{ type: "array", items: { type: "string" } }, schema] },
    },

    // Documentation and structure
    title: { title: "Title", description: "Human-readable label for this value.", type: "string" },
    description: {
      title: "Description",
      description: "What this value is, for the author reading the manifest.",
      type: "string",
    },
    deprecated: { title: "Deprecated", type: "boolean" },
    readOnly: { title: "Read only", type: "boolean" },
    writeOnly: { title: "Write only", type: "boolean" },
    $ref: {
      title: "Reference",
      description:
        "Pointer to another schema: `#/$defs/<Name>` for one declared below, `telo:<module>/<Type>` for a named type a module declared.",
      type: "string",
    },
    $defs: {
      title: "Definitions",
      description: "Named sub-schemas, private to this schema, referenced with `#/$defs/<Name>`.",
      type: "object",
      additionalProperties: schema,
    },
    definitions: {
      title: "Definitions (draft-07)",
      description: "Older spelling of `$defs`.",
      type: "object",
      additionalProperties: schema,
    },
    $comment: { title: "Comment", type: "string" },
    $id: { title: "Id", type: "string" },
    $schema: { title: "Schema dialect", type: "string" },
  };
}

/**
 * The `x-telo-*` annotation vocabulary — completion and hover only.
 *
 * TOTAL over {@link ANNOTATION_KEYWORDS} plus `x-telo-type`, which is what makes
 * it a description of the existing list rather than a second copy of it: adding
 * an annotation without a completion entry is a compile error here, and the
 * first draft of this map — hand-written — had already silently dropped four
 * annotations that live stdlib manifests use.
 *
 * Values are intentionally loose. What an annotation MEANS is checked by the
 * pass that owns it (`validate-ref-slots`, `validate-zone-slots`,
 * `validate-value-type-slots`), which reports in that annotation's own
 * vocabulary; restating the shape here would give one mistake two diagnostics
 * that disagree about what is wrong.
 *
 * A KNOWN BLIND SPOT, and not an oversight: several annotations
 * (`x-telo-context`, `x-telo-error-context`, `x-telo-step-context`) hold JSON
 * Schema themselves, and cannot be typed by the fragment this file feeds. A
 * literal `x-telo-*` key inside a hoisted `properties` map reads to the
 * annotation walkers as an annotated node, so the vocabulary has to stay out of
 * anything that enters a manifest — which leaves an annotation's VALUE with
 * neither validation nor completion. Closing it needs the walkers to distinguish
 * a schema describing an annotation from an annotation, which nothing does yet.
 */
export const TELO_SCHEMA_ANNOTATIONS: Record<
  // Exhaustive over the kind vocabulary, so adding a keyword without an entry is
  // a compile error. `x-telo-sensitive` is excluded because it belongs to the
  // DATA vocabulary below — it is read from a contract, not from a kind's own
  // `schema:` — and offering it here would put it on the one schema where
  // nothing reads it.
  | Exclude<(typeof ANNOTATION_KEYWORDS)[number], typeof X_TELO_SENSITIVE>
  | typeof X_TELO_TYPE,
  Record<string, unknown>
> = {
  "x-telo-eval": {
    title: "Evaluation mode",
    description:
      "When `${{ }}` / `!cel` in this field is evaluated: `compile` at load, `runtime` per invocation. A CEL-bearing field MUST declare one, or the expression is read as a literal.",
    type: "string",
    enum: ["compile", "runtime"],
  },
  "x-telo-ref": {
    title: "Reference slot",
    description:
      "This field holds a `!ref` to a resource — plus what the declaring resource DOES with it (`use`), which is what every topology analysis reads.",
    anyOf: [{ type: "string" }, { type: "object" }],
  },
  "x-telo-type": {
    title: "Value type",
    description:
      "What the value IS beyond JSON's types: `Telo.Bytes`, `Telo.Stream`, `Telo.TcpPort`, … Optionally parameterized (`{ name: Telo.Stream, of: Telo.Bytes }`).",
    anyOf: [{ type: "string" }, { type: "object" }],
  },
  "x-telo-scope": {
    title: "Execution scope",
    description:
      "JSON Pointer to a region whose `!ref`s resolve against this field's inline resources, created on entry and torn down on exit.",
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  },
  "x-telo-context": {
    title: "CEL context",
    description: "The CEL variables in scope inside this field, as a JSON Schema. Analyzer-only.",
    type: "object",
  },
  "x-telo-error-context": {
    title: "Error context",
    description: "Schema of the `error` CEL variable inside this field, at any nesting depth.",
    type: "object",
  },
  "x-telo-step-context": {
    title: "Step context",
    description:
      "On a step array: how to build typed `steps.<name>.result` from each item's invoked resource.",
    type: "object",
  },
  "x-telo-schema-from": {
    title: "Schema from",
    description: "Derive this field's validation schema from a sibling ref's definition schema.",
    type: "string",
  },
  "x-telo-schema-map": {
    title: "Schema map",
    description:
      "On the field a projection keys on: the JSON Schema node each of its values means. A lookup, never a computed expression.",
    type: "object",
  },
  "x-telo-schema-projection": {
    title: "Schema projection",
    description:
      "How a collection of typed entries projects to a JSON Schema object — which collection, which field keys it, and which fields modify it. Belongs on the kind DOCUMENT, beside 'schema:' rather than inside it, because it describes the whole declaration and not one field; written here it still works and is reported so it can be moved.",
    type: "object",
  },
  "x-telo-resource-rules": {
    title: "Resource rules",
    description:
      "Relationships between this kind's own fields that JSON Schema cannot state, as CEL over `self` (the resource) and `this` (the element `in:` iterates). `condition` is TRUE when the rule holds.",
    type: "array",
  },
  "x-telo-schema-projection-from": {
    title: "Schema projection from",
    description:
      "Replace this node with the projection of the entry collection declared by the kind referenced at the named field.",
    type: "string",
  },
  "x-telo-value-schema-from": {
    title: "Value schema from",
    description:
      "The value here must satisfy the type declared at the named field — checked for EVERY such slot, not only the branch a given input selects.",
    type: "string",
  },
  "x-telo-bindings-from": {
    title: "Bindings from",
    description: "Merge the names declared in the named field's map into this field's CEL scope.",
    type: "string",
  },
  "x-telo-context-from": {
    title: "Context from",
    description: "Merge the navigated value as a property map into this context node.",
    type: "string",
  },
  "x-telo-context-from-root": {
    title: "Context from root",
    description: "Replace this context node's schema with the value navigated from the manifest root.",
    type: "string",
  },
  "x-telo-context-from-ref-kind": {
    title: "Context from ref kind",
    description: "Type this node from a referenced kind's declared `inputType` / `outputType`.",
    type: "string",
  },
  "x-telo-context-ref-from": {
    title: "Context ref from",
    description: "Type this node from the named manifest's field, falling back to its kind's.",
    type: "string",
  },
  "x-telo-context-element-from": {
    title: "Context element from",
    description: "Type this binding from the ELEMENT of a sibling collection expression.",
    type: "string",
  },
  "x-telo-context-collection-from": {
    title: "Context collection from",
    description:
      "Type this binding from a sibling collection expression itself. Withheld when the collection is live — re-exposing a cursor being drained is what no member-access rule catches.",
    type: "string",
  },
  "x-telo-provides-zone": {
    title: "Provides zone",
    description:
      "This resource opens an execution zone; the annotated value is the CORRELATION KEY, never the zone (a zone is identified by the kind that provides it).",
    anyOf: [{ type: "boolean" }, { type: "string" }],
  },
  "x-telo-requires-zone": {
    title: "Requires zone",
    description:
      "This resource must be reached through the named providing kind's body, optionally correlated through an ordered pointer list.",
    anyOf: [{ type: "string" }, { type: "object" }],
  },
  "x-telo-widget": {
    title: "Editor widget",
    description: "Render this field with a richer control — `code` gives a Monaco editor.",
    type: "string",
    enum: ["code"],
  },
  "x-telo-topology-role": {
    title: "Topology role",
    description: "Names this field's part in the kind's topology, for the editor's graph view.",
    type: "string",
  },
  "x-telo-inline": {
    title: "Inline",
    description: "Renders this field's value inline in the editor rather than behind an accordion.",
    type: "boolean",
  },
  "x-telo-outcome-list": {
    title: "Outcome list",
    description: "Marks an array of conditional response-rendering entries (`returns:`).",
    anyOf: [{ type: "boolean" }, { type: "string" }],
  },
  "x-telo-catches-for": {
    title: "Catches for",
    description: "Names the field whose failures this branch list handles.",
    type: "string",
  },
};

/**
 * Annotations that belong on a DATA schema — an `inputType` / `outputType`
 * contract — rather than on a kind's own `schema:`.
 *
 * Split out because {@link TELO_SCHEMA_ANNOTATIONS} is offered only where the
 * fragment is `KindSchema`, which is a kind's CONFIGURATION. `x-telo-sensitive`
 * is read from the opposite place: the kernel resolves it off a bound contract,
 * which stamps `JsonSchema7`. Offering it from the kind vocabulary alone put it
 * on the one schema where nothing reads it and withheld it from the two where it
 * is the whole mechanism.
 */
export const TELO_DATA_SCHEMA_ANNOTATIONS: Record<
  typeof X_TELO_SENSITIVE,
  Record<string, unknown>
> = {
  [X_TELO_SENSITIVE]: {
    title: "Sensitive",
    description:
      "This value is auth material or equivalent: carry it as `[redacted]` in trace payloads and on the debug wire rather than verbatim. Read only from a resource's declared `inputType` / `outputType`.",
    type: "boolean",
  },
};
