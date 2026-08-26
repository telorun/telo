export type JsonSchemaProperty = {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  oneOf?: Array<{ type?: string; properties?: Record<string, JsonSchemaProperty>; [key: string]: unknown }>;
  anyOf?: Array<{ type?: string; properties?: Record<string, JsonSchemaProperty>; [key: string]: unknown }>;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: JsonSchemaProperty | boolean;
  propertyNames?: { pattern?: string };
  required?: string[];
  [key: string]: unknown;
};

export type JsonSchema = {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

/**
 * The site a form is rendering, so a CEL body written in it can be given the
 * scope the analyzer resolves for that exact address.
 *
 * The form knows a field's path relative to itself and nothing else; a scope is
 * a property of the field's position in its RESOURCE, so the resource and the
 * form's own pointer into it have to be told. Absent when the host cannot say —
 * a form rendered outside a resource offers no completion rather than a guess.
 */
export interface CelFieldTarget {
  resource: { kind: string; name: string };
  /** JSON pointer of the form's scope within the resource ("" at its root). */
  pointer: string;
}

export interface ResolvedResourceOption {
  kind: string;
  name: string;
  capability?: string;
}

/** An importable `Telo.Type` kind the user can instantiate inline (e.g.
 *  `Type.JsonSchema`, or a future `Cue.Schema`). Sourced from the module's
 *  available kinds — only kinds actually imported appear, so the editor never
 *  hardcodes a type system. */
export interface TypeKindOption {
  /** User-facing (alias-form) kind, e.g. `"Type.JsonSchema"`. */
  kind: string;
  /** The kind's definition schema — drives the inline body form. */
  schema: Record<string, unknown>;
}
