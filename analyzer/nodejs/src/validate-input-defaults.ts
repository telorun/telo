import { isTaggedSentinel } from "@telorun/templating";
import type { ResourceManifest } from "@telorun/sdk";
import { hostAnchorFor } from "./host-path-slot.js";
import { decodePlainLiterals, mapTextLeaves } from "./plain-literal-decoding.js";
import { residualEntrySchema } from "./residual-schema.js";
import { validateAgainstSchema } from "./schema-compat.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** Stands in for a relative host path, which is anchored rather than refused
 *  here — the relative-default rules live in `validate-host-path-defaults.ts`. */
const ANCHORED = "/";

/**
 * A module input's `default:` checked against the input's own declaration — the
 * static twin of the kernel's resolution, which validates the default it falls
 * back to and refuses the whole application at boot when it does not fit.
 *
 * An Application binding's default is host TEXT's stand-in, so it is read the
 * way the kernel reads it: decoded through each instance type's plain encoding
 * and checked against the residual schema. A Library's default is an ordinary
 * JSON Schema annotation, checked against the rest of its entry.
 *
 * Entry-module-scoped: a dependency's inputs are its author's to fix.
 */
export function validateInputDefaults(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const manifest of manifests) {
    if (manifest.kind !== "Telo.Application" && manifest.kind !== "Telo.Library") continue;
    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    const name = typeof metadata.name === "string" ? metadata.name : "";
    if (!rootModules.has(name)) continue;
    for (const block of ["variables", "secrets"] as const) {
      const entries = (manifest as Record<string, unknown>)[block];
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      for (const [key, raw] of Object.entries(entries as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const entry = raw as Record<string, unknown>;
        // A default holding a tag at any depth is never read as a value;
        // `MODULE_PATH_OUTSIDE_RESOURCE` and its siblings report the tag.
        if (entry.default === undefined || holdsTag(entry.default)) continue;
        const binding = "env" in entry || "arg" in entry;
        const { default: fallback, ...rest } = entry;
        const schema = binding ? residualEntrySchema(entry) : rest;
        const value = mapTextLeaves(
          binding ? decodePlainLiterals(structuredClone(fallback), schema) : structuredClone(fallback),
          schema,
          (slot, text) => (hostAnchorFor(slot, text) !== undefined ? ANCHORED : text),
        );
        for (const issue of validateAgainstSchema(value, schema)) {
          // The rendered issue opens with its instance path, `/` for the whole value.
          const text = issue.message.replace(/^\/ /, "");
          out.push({
            severity: DiagnosticSeverity.Error,
            code: "DEFAULT_INVALID",
            source: SOURCE,
            message:
              `${manifest.kind}/${name}: the default of ${block}.${key} ${text}. ` +
              `A default is the value the input holds when nothing supplies one, so it must ` +
              `satisfy the input's own declaration.`,
            data: {
              resource: { kind: manifest.kind, name },
              filePath: typeof metadata.source === "string" ? metadata.source : undefined,
              path: `${block}.${key}.default`,
            },
          });
        }
      }
    }
  }
  return out;
}

function holdsTag(value: unknown): boolean {
  if (isTaggedSentinel(value)) return true;
  if (Array.isArray(value)) return value.some(holdsTag);
  if (value !== null && typeof value === "object") return Object.values(value).some(holdsTag);
  return false;
}
