import { isInstanceSlot } from "@telorun/sdk";

/**
 * Build the residual JSON Schema for a `variables` / `secrets` entry.
 *
 * For Telo.Application host-binding entries (those with an `env:` or `arg:`
 * key), strips the kernel-specific wrapper keys `env`, `arg` and `default` —
 * `default` here is the *fallback host value* the kernel coerces when no host
 * channel supplies one, not a JSON Schema annotation, so it must not leak into
 * the validator.
 *
 * For Telo.Library entries (neither key), passes the entry through unchanged.
 * Library `default:` is a standard JSON Schema annotation and stays.
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
  // On a binding whose value is an instance (a timestamp, bytes), `type:` names
  // how the host text is read — the plain encoding's JSON type — not the value,
  // so it would refuse every decoded one.
  const coercionOnly = isAppEnvBinding && isInstanceSlot(entry);
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
