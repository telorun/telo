/**
 * Whether a kind's `x-telo-value-schema-from` annotations name a location its
 * own schema can hold a value at — in a configuration slot of `schema:`, and
 * inside its `inputType` / `outputType`, written there or in the named shape
 * the field names.
 *
 * A location nothing can be written at types its node from nothing: the slot
 * silently stops being checked, and a contract node silently reopens. One reader
 * for both halves: `telo check` reports `VALUE_SCHEMA_FROM_INVALID` at the
 * annotation, and the kernel raises `ERR_VALUE_SCHEMA_FROM_INVALID` when it
 * registers the definition, so a dependency's kind is refused too.
 *
 * Browser-safe: no Node built-ins.
 */
import { parseCanonicalTypeSchemaId } from "@telorun/sdk";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import {
  readValueSchemaLocation,
  schemaReachesLocation,
  valueSchemaAnnotations,
} from "./value-schema-slot.js";

export interface ValueSchemaFromProblem {
  /** Where the annotation is written, from the definition document
   *  (`inputType.schema.properties.context.x-telo-value-schema-from`) — the
   *  contract field itself when a named shape carries it. */
  path: string;
  message: string;
}

const ANNOTATION = "x-telo-value-schema-from";

/** The definition fields an annotation is read in. */
const ANNOTATED_FIELDS = ["schema", "inputType", "outputType"] as const;

/**
 * The shape a contract field NAMES, or undefined when the field holds its
 * schema itself (inline, or raw) — in every spelling a host meets one: the
 * `!ref` tag, the reference it resolves to, a canonical id, a bare name.
 */
export function namedContractShape(
  typeField: unknown,
): { name: string; alias?: string } | undefined {
  if (typeof typeField === "string") return typeField.length > 0 ? { name: typeField } : undefined;
  const tagged = refSentinelTarget(typeField);
  if (tagged) return { name: tagged.name, alias: tagged.alias };
  if (!typeField || typeof typeField !== "object" || Array.isArray(typeField)) return undefined;
  const field = typeField as Record<string, unknown>;
  if (field.schema !== undefined || field.type !== undefined || field.properties !== undefined) {
    return undefined;
  }
  if (typeof field.name === "string") {
    return { name: field.name, alias: typeof field.alias === "string" ? field.alias : undefined };
  }
  const canonical = parseCanonicalTypeSchemaId(field.$ref);
  return canonical ? { name: canonical.typeName } : undefined;
}

/** A contract field that names a shape declared elsewhere, as resolved. */
export interface NamedContractShape {
  /** The shape's name, as a diagnostic says it. */
  name: string;
  /** The shape's own document. */
  schema: Record<string, any>;
}

/**
 * Every unreadable or unreachable `x-telo-value-schema-from` of one definition.
 *
 * `schema` is the kind's author schema with inheritance resolved — a location
 * may name a field an ancestor declares. An annotation is judged wherever the
 * contract resolver types it: in the definition's own fields, and in the
 * document of the named shape an `inputType` / `outputType` names, which
 * `resolveShape` reads. The shape's annotations are this kind's there, so each
 * kind naming one shape is judged against its own schema, at the field; a field
 * `resolveShape` cannot read is not judged.
 */
export function valueSchemaFromProblems(
  definition: Record<string, any>,
  schema: Record<string, any> | undefined,
  resolveShape?: (typeField: unknown) => NamedContractShape | undefined,
): ValueSchemaFromProblem[] {
  const problems: ValueSchemaFromProblem[] = [];
  const kindName = String(definition.metadata?.name);
  const unreachable = (raw: unknown, where: string): string =>
    `'${kindName}' declares \`${ANNOTATION}: ${String(raw)}\` ${where}, but its schema ` +
    `declares nothing at that location, so no resource of the kind can name a type there ` +
    `and the annotated node would be typed from nothing. Name a field the kind's ` +
    `\`schema:\` declares — by name, or by a JSON Pointer from the resource root, which may ` +
    `continue through a reference slot and range over a list with '*'.`;

  for (const field of ANNOTATED_FIELDS) {
    const written = definition[field];
    for (const { path, raw } of valueSchemaAnnotations(written, field)) {
      const at = `${path}.${ANNOTATION}`;
      const location = readValueSchemaLocation(raw);
      if (!location) continue;
      if ("invalid" in location) {
        problems.push({ path: at, message: `'${kindName}' at '${at}': ${location.invalid}` });
      } else if (!schema || !schemaReachesLocation(schema, location.segments)) {
        problems.push({ path: at, message: unreachable(raw, `at '${at}'`) });
      }
    }

    const shape = field === "schema" ? undefined : resolveShape?.(written);
    if (!shape) continue;
    for (const { path, raw } of valueSchemaAnnotations(shape.schema)) {
      const within = path === "" ? "its root" : `'${path}'`;
      const where = `through \`${field}\`, which names the shape '${shape.name}' carrying it at ${within}`;
      const location = readValueSchemaLocation(raw);
      if (!location) continue;
      if ("invalid" in location) {
        problems.push({ path: field, message: `'${kindName}' ${where}: ${location.invalid}` });
      } else if (!schema || !schemaReachesLocation(schema, location.segments)) {
        problems.push({ path: field, message: unreachable(raw, where) });
      }
    }
  }
  return problems;
}
