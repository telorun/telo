import { isInstanceSlot } from "@telorun/sdk";
import { admitsAbsence } from "./configuration-dimensions.js";

/**
 * Build the residual JSON Schema for a `variables` / `secrets` entry.
 *
 * For Telo.Application host-binding entries (those with an `env:` or `arg:`
 * key), strips the kernel-specific wrapper keys `env`, `arg` and `default` —
 * `default` here is the *fallback host value* the kernel coerces when no host
 * channel supplies one, not a JSON Schema annotation, so it must not leak into
 * the validator.
 *
 * For Telo.Library entries (neither key), `default:` is a standard JSON Schema
 * annotation and stays.
 *
 * Single source of truth for "residual schema" referenced by both the
 * analyzer's CEL globals normalization and the kernel's runtime env-var
 * resolver — keeping them aligned prevents the two surfaces from drifting.
 */
export function residualEntrySchema(
  entry: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { type: "object", additionalProperties: true };
  }
  const isAppEnvBinding = "env" in entry || "arg" in entry;
  // On an entry whose value is an instance (a timestamp, bytes), `type:` names
  // how text is read — the plain encoding's JSON type — not the value, so it
  // would refuse every decoded one.
  const coercionOnly = isInstanceSlot(entry);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (isAppEnvBinding && (key === "env" || key === "arg" || key === "default")) continue;
    if (coercionOnly && key === "type") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Apply `residualEntrySchema` to every entry in a `variables` / `secrets` map.
 * Returns a property-map suitable for use as the inner schema of CEL's
 * `variables` / `secrets` namespaces.
 */
export function residualEntrySchemaMap(
  entries: Record<string, unknown> | null | undefined,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return out;
  }
  for (const [name, value] of Object.entries(entries)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[name] = residualEntrySchema(value as Record<string, unknown>);
    }
  }
  return out;
}

/** `schema` admitting `null` beside every value it already admits — the
 *  reading of an input that may be absent (`default: null`). Written as a `type`
 *  list holding `null`, the spelling the nullable-access rule reads, with `null`
 *  joined to a closed `enum` / `const`. */
export function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  if (typeof schema.type === "string") out.type = schema.type === "null" ? "null" : [schema.type, "null"];
  else if (Array.isArray(schema.type) && !schema.type.includes("null")) out.type = [...schema.type, "null"];
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) out.enum = [...schema.enum, null];
  if (Object.hasOwn(schema, "const")) {
    out.enum = [schema.const, null];
    delete out.const;
  }
  return out;
}

/** The schema an input's VALUE is held to: its residual schema, admitting `null`
 *  where the entry declares `default: null`. */
export function inputValueSchema(entry: Record<string, unknown>): Record<string, unknown> {
  const residual = residualEntrySchema(entry);
  return admitsAbsence(entry) ? nullable(residual) : residual;
}
