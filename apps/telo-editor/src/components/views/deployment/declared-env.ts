import type { DeclaredEnvEntry } from "./DeclaredEnvEditor";

interface ManifestLike {
  kind: "Application" | "Library";
  variables?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
}

/** Project a parsed Application manifest's declared env contract into the
 *  flat row model the editor's Environment tab renders. Library manifests
 *  (which never carry `env:`) return an empty list — the tab is
 *  Application-only. */
export function extractDeclaredEnvEntries(
  manifest: ManifestLike | null | undefined,
): DeclaredEnvEntry[] {
  if (!manifest || manifest.kind !== "Application") return [];
  const out: DeclaredEnvEntry[] = [];
  collect(manifest.variables, false, out);
  collect(manifest.secrets, true, out);
  return out;
}

function collect(
  block: Record<string, unknown> | undefined,
  secret: boolean,
  out: DeclaredEnvEntry[],
): void {
  if (!block || typeof block !== "object" || Array.isArray(block)) return;
  for (const [name, raw] of Object.entries(block)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const envVar = typeof entry.env === "string" ? entry.env : null;
    const type = typeof entry.type === "string" ? entry.type : null;
    if (!envVar || !isSupportedType(type)) continue;
    out.push({
      name,
      envVar,
      type,
      secret,
      defaultText: formatDefault(entry.default),
      constraints: summariseConstraints(entry),
    });
  }
}

function isSupportedType(
  value: string | null,
): value is DeclaredEnvEntry["type"] {
  return (
    value === "string" ||
    value === "integer" ||
    value === "number" ||
    value === "boolean" ||
    value === "object" ||
    value === "array"
  );
}

function formatDefault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function summariseConstraints(entry: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const omit = new Set(["env", "default", "type", "description", "title"]);
  if (entry.minimum !== undefined || entry.maximum !== undefined) {
    const min = entry.minimum !== undefined ? `≥ ${entry.minimum}` : "";
    const max = entry.maximum !== undefined ? `≤ ${entry.maximum}` : "";
    parts.push([min, max].filter(Boolean).join(", "));
  }
  if (Array.isArray(entry.enum)) {
    parts.push(`enum: ${entry.enum.join(", ")}`);
  }
  if (typeof entry.pattern === "string") {
    parts.push(`pattern: ${entry.pattern}`);
  }
  if (typeof entry.format === "string") {
    parts.push(`format: ${entry.format}`);
  }
  if (entry.minLength !== undefined || entry.maxLength !== undefined) {
    const min = entry.minLength !== undefined ? `min length ${entry.minLength}` : "";
    const max = entry.maxLength !== undefined ? `max length ${entry.maxLength}` : "";
    parts.push([min, max].filter(Boolean).join(", "));
  }
  if (entry.minItems !== undefined || entry.maxItems !== undefined) {
    const min = entry.minItems !== undefined ? `min items ${entry.minItems}` : "";
    const max = entry.maxItems !== undefined ? `max items ${entry.maxItems}` : "";
    parts.push([min, max].filter(Boolean).join(", "));
  }
  const items = entry.items as Record<string, unknown> | undefined;
  if (items && typeof items.type === "string") {
    parts.push(`array of ${items.type}`);
  }
  const properties = entry.properties as Record<string, unknown> | undefined;
  if (properties && Object.keys(properties).length > 0) {
    parts.push(`object{${Object.keys(properties).join(", ")}}`);
  }
  // Carry over any remaining unrecognised JSON Schema keywords as a hint that
  // the manifest has constraints we don't pretty-print here.
  const extra = Object.keys(entry).filter(
    (k) =>
      !omit.has(k) &&
      ![
        "minimum",
        "maximum",
        "enum",
        "pattern",
        "format",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "items",
        "properties",
      ].includes(k),
  );
  if (extra.length > 0) {
    parts.push(`+ ${extra.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
