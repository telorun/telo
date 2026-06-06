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
