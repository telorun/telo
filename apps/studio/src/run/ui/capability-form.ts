import type { JSONSchema7 } from "json-schema";
import type { RunnerCapabilities } from "../types";

/**
 * Merge a runner's advertised capability schema on top of the adapter's static
 * bootstrap schema. The bootstrap schema owns `baseUrl` (client-owned); the
 * capability schema contributes the runner's editable fields (image, pullPolicy,
 * …). Returns the bootstrap schema unchanged when there are no capabilities
 * (older/unreachable runner → only `baseUrl` is shown).
 */
export function mergeCapabilitySchema(
  bootstrap: JSONSchema7,
  caps: RunnerCapabilities | null,
): JSONSchema7 {
  if (!caps) return bootstrap;
  const advertised = caps.config.schema;
  return {
    ...bootstrap,
    properties: { ...bootstrap.properties, ...(advertised.properties ?? {}) },
    required: dedupe([
      ...(asStringArray(bootstrap.required)),
      ...(asStringArray(advertised.required)),
    ]),
  };
}

/**
 * Reconcile a config against a schema's per-property `default`s. Editable fields
 * are filled only when missing, so user edits are never clobbered. A `readOnly`
 * (server-enforced) field's advertised default is authoritative — it overwrites
 * any existing (possibly stale) value, so re-pointing a runner at an enforced
 * backend can't carry a wrong image/pullPolicy onto the wire or into the
 * disabled field.
 */
export function applySchemaDefaults(
  schema: JSONSchema7,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const props = schema.properties;
  if (!props || typeof props !== "object") return config;
  const next = { ...config };
  for (const [key, raw] of Object.entries(props)) {
    if (!raw || typeof raw !== "object") continue;
    const prop = raw as { default?: unknown; readOnly?: boolean };
    const hasDefault = "default" in prop && prop.default !== undefined;
    if (!hasDefault) continue;
    // Enforced field → default wins; editable field → only fill when missing.
    if (prop.readOnly === true || !(key in next)) {
      next[key] = prop.default;
    }
  }
  return next;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
