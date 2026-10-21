/**
 * The `x-telo-*` annotation vocabulary an author writes inside a manifest's
 * schemas, as data — completion and hover only.
 *
 * The JSON Schema KEYWORDS themselves are the `JsonSchema7` / `KindSchema`
 * fragments (`sdk/builtins/fragments/`), which completion reads off the schema
 * a slot is stamped with, so the validator's rules and the editor's
 * suggestions come from one vocabulary.
 *
 * WHY THE ANNOTATIONS ARE NOT IN THE VALIDATING FRAGMENT. `x-telo-*` keys are
 * offered by completion but deliberately never appear as literal property names
 * in the schema that gets hoisted into a manifest. Several passes walk a
 * definition's schema testing every object for an annotation KEY
 * (`resolveSchemaRefKinds`, `validate-ref-slots`, `validate-zone-slots`), and a
 * `properties` map holding a key spelled `x-telo-ref` reads to them as an
 * annotated node — inventing diagnostics about a slot the author never wrote.
 * So the fragment body stays open (`additionalProperties: true`, which admits
 * every annotation) and the annotation vocabulary stays here, on the analyzer
 * side of the boundary, where no manifest walk can reach it.
 *
 * Browser-safe: no Node built-ins.
 */

import { X_TELO_TYPE } from "@telorun/sdk";

/** The annotations read from a DATA schema rather than a kind schema. */
const X_TELO_SENSITIVE = "x-telo-sensitive" as const;
const X_TELO_SPAN_ATTRIBUTE = "x-telo-span-attribute" as const;
const X_TELO_TEXT_CONTEXT = "x-telo-text-context" as const;
const X_TELO_TEXT_VALUES_FOR = "x-telo-text-values-for" as const;
const X_TELO_TEXT_VALUES = "x-telo-text-values" as const;
/** Read on a binding of an `x-telo-context` alone. */
const X_TELO_CONTEXT_EVAL = "x-telo-context-eval" as const;
const X_TELO_CONTEXT_FROM_REFERRER = "x-telo-context-from-referrer" as const;
const X_TELO_CONTEXT_ITEM_FILLS = "x-telo-context-item-fills" as const;
import { ANNOTATION_KEYWORDS } from "./value-type-keyword.js";

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
  // a compile error. `x-telo-sensitive` and `x-telo-span-attribute` are
  // excluded because they belong to the DATA vocabulary below — they are read
  // from a contract, not from a kind's own `schema:` — and offering them here
  // would put them on the one schema where nothing reads them.
  | Exclude<
      (typeof ANNOTATION_KEYWORDS)[number],
      | typeof X_TELO_SENSITIVE
      | typeof X_TELO_SPAN_ATTRIBUTE
      | typeof X_TELO_TEXT_CONTEXT
      | typeof X_TELO_CONTEXT_EVAL
      | typeof X_TELO_CONTEXT_FROM_REFERRER
      | typeof X_TELO_CONTEXT_ITEM_FILLS
    >
  | typeof X_TELO_TYPE,
  Record<string, unknown>
> = {
  "x-telo-eval": {
    title: "Evaluation mode",
    description:
      "When CEL in this field (`!cel`, `!interpolate`) is evaluated: `compile` at load, `runtime` per invocation. `accessor` is never evaluated — the field holds a plain `!cel` chain rooted at one of its `x-telo-context` bindings, or a literal, and the controller receives it as a binding. A CEL-bearing field MUST declare one, or the expression is read as a literal.",
    type: "string",
    enum: ["compile", "runtime", "accessor"],
  },
  "x-telo-browser-export": {
    title: "Browser export",
    description:
      "This string names an export of a browser entry. `entry` is a JSON Pointer, relative to the enclosing object, to the sibling string holding the entry's specifier — one the module declaring the resource lists under `exports.browser`.",
    type: "object",
    required: ["entry"],
    properties: { entry: { type: "string" } },
    additionalProperties: false,
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
      "JSON Pointer to a region whose `!ref`s resolve against this field's inline resources, created on entry and torn down on exit. Legal only on a named top-level property of the resource.",
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
      "Replace this node with the projection of the declaration at the named field — a JSON Pointer that crosses references, or `{ from, pick?, omit? }` to select one entry or drop some. On a kind document, beside `schema:`: every declaration of the kind projects as that derivation.",
    anyOf: [{ type: "string" }, { type: "object" }],
  },
  "x-telo-returns-from": {
    title: "Returns from",
    description:
      "The CEL value here is a function's result: it must satisfy the `returns:` declaration at the named root field.",
    type: "string",
  },
  "x-telo-unbound-calls": {
    title: "Unbound calls",
    description:
      "Expressions here are evaluated where no module function is bound, so a module call in them is refused. On a string field, the field's plain text is itself such an expression. The value is the reason the diagnostic quotes.",
    type: "string",
  },
  "x-telo-value-schema-from": {
    title: "Value schema from",
    description:
      "The value here must satisfy the type declared at the named location — a field of the resource, or a JSON Pointer from its root that may cross a reference and range over a list with '*'. On a configuration slot every such slot is checked, not only the branch a given input selects; inside inputType / outputType the node is typed by every type the location reaches.",
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
    description:
      "Replace this context node's schema with the value navigated from the manifest root. When the path holds nothing, the node keeps the schema keywords it declares itself.",
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
  "x-telo-context-parameters-from": {
    title: "Context parameters from",
    description:
      "Merge the named ordered parameter list (`[{ name, schema, nullable?, optional? }]`) into this context node — one binding per parameter, typed from its schema, and the node closed so a typo below one is reported.",
    type: "string",
  },
  "x-telo-context-element-from": {
    title: "Context element from",
    description: "Type this binding from the ELEMENT of a sibling collection expression.",
    type: "string",
  },
  "x-telo-context-element-from-item": {
    title: "Context element from item",
    description:
      "Type this binding from the ELEMENT of the collection the named field of the enclosing array item points at — a plain chain rooted at another binding of this context, or at inputs. Untyped when the chain does not resolve to a collection.",
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
  [X_TELO_TEXT_VALUES]: {
    title: "Text values",
    description:
      "On a `Text` or `Message` node: the values whoever shows the text formats it with, by name, each typed as a string or a number (`{}` for none). A placeholder or plural selector the text reads that is not one of them is refused where the text is written.",
    type: "object",
  },
  [X_TELO_TEXT_VALUES_FOR]: {
    title: "Text values for",
    description:
      "This object holds the values of a message: a JSON Pointer, relative to the enclosing value (for a callable parameter, the call's arguments keyed by parameter name), to the `Text` they bind. Every placeholder and plural selector of that text must be one of its keys, holding a string or a number.",
    type: "string",
  },
  "x-telo-match-for": {
    title: "Match for",
    description:
      "This field holds a JSON Schema matched against the value an accessor field names: a JSON Pointer, relative to the object enclosing this field, to that `x-telo-eval: accessor` field. A schema that can never hold for the accessor's type is refused.",
    type: "string",
  },
  "x-telo-text-catalog-set": {
    title: "Text catalog set",
    description:
      "The catalogs at and beneath this node form one lookup set: each catalog written here, and the catalogs of every resource a reference here names (through that resource's own catalog sets). A text and context translated twice in one language across the set is refused. Only `true`; never nested under another catalog set.",
    type: "boolean",
    const: true,
  },
  "x-telo-catches-for": {
    title: "Catches for",
    description:
      "Whose failures this catch list renders: a sibling field naming the handler, " +
      "or the EMPTY string for everything this resource drives — a scope-level list, " +
      "which owes coverage of nothing itself and answers for every site it encloses.",
    type: "string",
  },
};

/**
 * Annotations read on a BINDING — a property of an `x-telo-context` — and
 * nowhere else, offered there alone.
 */
export const TELO_CONTEXT_BINDING_ANNOTATIONS: Record<
  typeof X_TELO_CONTEXT_EVAL | typeof X_TELO_CONTEXT_FROM_REFERRER | typeof X_TELO_CONTEXT_ITEM_FILLS,
  Record<string, unknown>
> = {
  [X_TELO_CONTEXT_FROM_REFERRER]: {
    title: "Context from referrer",
    description:
      "Type this binding from the binding of the named name in scope at each slot referencing the resource — a field's record from the form holding it. Only on a binding marked `x-telo-context-eval: accessor`. Judged once per distinct referrer type; with no referrer the binding is what it declares itself.",
    type: "string",
  },
  [X_TELO_CONTEXT_ITEM_FILLS]: {
    title: "Context item fills",
    description:
      "On a binding of a region declared on a list: which member of the binding each item fills, the first pointer yielding a string (`''` the item itself, `/property` its `property`, read through a reference). Items reading each other's members in a cycle are refused.",
    type: "array",
    minItems: 1,
    items: { type: "string" },
  },
  [X_TELO_CONTEXT_EVAL]: {
    title: "Context eval modes",
    description:
      "The eval modes this binding exists at: `compile`, `runtime`, `accessor`, or a list of them. Absent, every mode. At a site of another mode the binding is out of scope — `accessor` alone keeps it out of every evaluated expression, and a binding without `accessor` cannot root an accessor field's chain.",
    anyOf: [
      { type: "string", enum: ["compile", "runtime", "accessor"] },
      { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: ["compile", "runtime", "accessor"] } },
    ],
  },
};

/**
 * Annotations that belong on a DATA schema — an `inputType` / `outputType`
 * contract — rather than on a kind's own `schema:`.
 *
 * Split out because {@link TELO_SCHEMA_ANNOTATIONS} is offered only where the
 * fragment is `KindSchema`, which is a kind's CONFIGURATION. `x-telo-sensitive`
 * (and `x-telo-span-attribute` beside it) is read from the opposite place: the kernel resolves it off a bound contract,
 * which stamps `JsonSchema7`. Offering it from the kind vocabulary alone put it
 * on the one schema where nothing reads it and withheld it from the two where it
 * is the whole mechanism.
 */
export const TELO_DATA_SCHEMA_ANNOTATIONS: Record<
  | typeof X_TELO_SENSITIVE
  | typeof X_TELO_SPAN_ATTRIBUTE
  | typeof X_TELO_TEXT_CONTEXT
  | typeof X_TELO_TEXT_VALUES
  | typeof X_TELO_TEXT_VALUES_FOR,
  Record<string, unknown>
> = {
  [X_TELO_TEXT_CONTEXT]: {
    title: "Text context",
    description:
      "The context of this node's `title`, `description` and enum labels: what tells the same words used elsewhere apart, so a catalog entry translates them here only. Read on a data schema — a named shape, a contract, a status block, a callable's parameters and result.",
    type: "string",
    minLength: 1,
  },
  [X_TELO_TEXT_VALUES]: {
    title: "Text values",
    description:
      "On a `Text` or `Message` node: the values whoever shows the text formats it with, by name, each typed as a string or a number (`{}` for none). A placeholder or plural selector the text reads that is not one of them is refused where the text is written.",
    type: "object",
  },
  [X_TELO_TEXT_VALUES_FOR]: {
    title: "Text values for",
    description:
      "This object holds the values of a message: a JSON Pointer, relative to the enclosing value (for a callable parameter, the call's arguments keyed by parameter name), to the `Text` they bind. Every placeholder and plural selector of that text must be one of its keys, holding a string or a number.",
    type: "string",
  },
  [X_TELO_SENSITIVE]: {
    title: "Sensitive",
    description:
      "This value is auth material or equivalent: carry it as `[redacted]` in trace payloads and on the debug wire rather than verbatim. Read only from a resource's declared `inputType` / `outputType`.",
    type: "boolean",
  },
  [X_TELO_SPAN_ATTRIBUTE]: {
    title: "Span attribute",
    description:
      "Put this scalar property's value on the resource's dispatch span under this attribute name (e.g. `telo.check.exit_code`). Read only from a resource's declared `inputType` / `outputType`, on a property reached through `properties`.",
    type: "string",
  },
};
