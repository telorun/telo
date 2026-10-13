/** One field of a kind, an input or an output, as a table row. */
export interface SchemaField {
  name: string;
  /** How the field's type reads: `string`, `integer`, `ref → Sql.Connection`. */
  type: string;
  required: boolean;
  description: string;
  /** The default as the manifest wrote it, already text; empty for none. */
  default: string;
  /** The allowed values of an enumerated field. */
  options: string[];
}

/** What a kind's definition says an author writes and a caller exchanges. */
export interface KindSchema {
  /** The fields of a resource of this kind. */
  fields: SchemaField[];
  /** What it is invoked with, and what it answers — for kinds that are invoked. */
  inputs: SchemaField[];
  outputs: SchemaField[];
}

export type KindSchemas = Record<string, KindSchema>;

/** A value to stand in for a required field in a usage example. */
function placeholder(field: SchemaField): string {
  if (field.options.length > 0) return field.options[0];
  if (field.type.startsWith("ref")) return "!ref someResource";
  switch (field.type.split(" ")[0]) {
    case "integer":
    case "number":
      return "0";
    case "boolean":
      return "false";
    case "array":
      return "[]";
    case "object":
      return "{}";
    default:
      return '"…"';
  }
}

/** The smallest resource of a kind an author could write: the kind under the
 *  alias the module is imported as, a name, and every required field with a
 *  stand-in value. A sketch to edit, not a manifest that runs. */
export function usageExample(alias: string, kind: string, schema: KindSchema): string {
  const lines = [
    `kind: ${alias}.${kind}`,
    "metadata:",
    `  name: my${kind}`,
    ...schema.fields.filter((f) => f.required).map((f) => `${f.name}: ${placeholder(f)}`),
  ];
  return lines.join("\n");
}
