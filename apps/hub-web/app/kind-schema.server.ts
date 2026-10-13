import { parseAllDocuments } from "yaml";

import type { KindSchema, KindSchemas, SchemaField } from "@/kind-schema";

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A value as the manifest would show it on one line. */
function literal(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** How a property's type reads in a table cell. A reference slot names the
 *  kinds it accepts; a union lists its branches; a nominal value type
 *  (`x-telo-type`) is more telling than the JSON type beneath it. */
function typeOf(schema: Json): string {
  const slot = schema["x-telo-ref"];
  if (slot !== undefined) {
    const kinds = typeof slot === "string" ? slot : record(slot)?.kind;
    return `ref → ${Array.isArray(kinds) ? kinds.join(" | ") : literal(kinds)}`;
  }
  const nominal = schema["x-telo-type"];
  if (typeof nominal === "string") return nominal;
  const named = record(nominal)?.name;
  if (typeof named === "string") return named;
  if (typeof schema.$ref === "string") return schema.$ref.split("/").pop() ?? "";
  for (const union of ["anyOf", "oneOf"]) {
    const branches = schema[union];
    if (Array.isArray(branches)) {
      return branches
        .map((branch) => (record(branch) ? typeOf(record(branch)!) : ""))
        .filter(Boolean)
        .join(" | ");
    }
  }
  if (schema.const !== undefined) return literal(schema.const);
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (schema.type === "array") {
    const items = record(schema.items);
    return items ? `array of ${typeOf(items) || "any"}` : "array";
  }
  return text(schema.type) || (Array.isArray(schema.enum) ? "enum" : "any");
}

/** The rows of an object schema: its declared properties, in authored order. */
function fields(schema: unknown): SchemaField[] {
  const object = record(schema);
  const properties = record(object?.properties);
  if (!properties) return [];
  const required = Array.isArray(object?.required) ? object.required : [];
  return Object.entries(properties).flatMap(([name, value]) => {
    const property = record(value);
    if (!property) return [];
    return [
      {
        name,
        type: typeOf(property),
        required: required.includes(name),
        description: text(property.description),
        default: literal(property.default),
        options: Array.isArray(property.enum) ? property.enum.map(literal) : [],
      },
    ];
  });
}

/** A contract part (`inputType` / `outputType`) written inline: a
 *  `Telo.JsonSchema` wrapping the schema. One written as a reference to a named
 *  shape has no fields to read here. */
function contractFields(contract: unknown): SchemaField[] {
  return fields(record(contract)?.schema);
}

/**
 * The field tables of every kind a manifest defines, by kind name.
 *
 * Read from the manifest text with a plain YAML parser: this app may not depend
 * on the analyzer, and needs none of what it does — only each definition's own
 * `schema.properties`. Telo's tags (`!cel`, `!ref`, …) are unknown to the
 * parser and read as the plain values beneath them, which is all a table shows.
 * Inherited fields are not followed: a kind extending another lists what its
 * own document declares.
 *
 * A manifest that does not parse yields no tables rather than an error — the
 * page is still the module's page without them.
 */
export function readKindSchemas(manifest: string): KindSchemas {
  const schemas: KindSchemas = {};
  for (const document of parseAllDocuments(manifest, { logLevel: "silent" })) {
    if (document.errors.length > 0) continue;
    const doc = record(document.toJS());
    if (!doc || (doc.kind !== "Telo.Definition" && doc.kind !== "Telo.Abstract")) continue;
    const name = text(record(doc.metadata)?.name);
    if (!name) continue;
    const schema: KindSchema = {
      fields: fields(doc.schema),
      inputs: contractFields(doc.inputType),
      outputs: contractFields(doc.outputType),
    };
    if (schema.fields.length + schema.inputs.length + schema.outputs.length > 0) {
      schemas[name] = schema;
    }
  }
  return schemas;
}
