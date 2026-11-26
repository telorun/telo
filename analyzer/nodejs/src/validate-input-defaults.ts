import { isTaggedSentinel } from "@telorun/templating";
import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { hostAnchorFor } from "./host-path-slot.js";
import { declaringModuleScope } from "./module-alias-scope.js";
import { decodePlainLiterals, mapTextLeaves } from "./plain-literal-decoding.js";
import { residualEntrySchema } from "./residual-schema.js";
import { canonicalShapeSchema, withCanonicalRefSentinels } from "./resolve-schema-type-refs.js";
import { SCHEMA_NESTING_EXCEEDED, schemaNestingExceededMessage, validateAgainstSchemaWithShapes } from "./schema-validation.js";
import { valueTypeRefusalCode } from "./schema-error-report.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

type Schema = Record<string, any>;

/** The alias scopes a module document's entries are read in. */
export interface InputDefaultsScope {
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
}

/** `schema` with every named-shape reference made canonical in `module`. */
export function canonicalInModule(schema: Schema, module: string, scope: InputDefaultsScope): Schema {
  const aliases = declaringModuleScope(module, scope.aliases, {
    aliasesByModule: scope.aliasesByModule,
    rootModules: new Set(scope.rootModules),
  });
  const moduleForAlias = (alias: string) => aliases.moduleForAlias(alias);
  return canonicalShapeSchema(withCanonicalRefSentinels(schema, module, moduleForAlias) as Schema, module, moduleForAlias);
}

const SOURCE = "telo-analyzer";

/** Stands in for a relative host path, which is anchored rather than refused
 *  here — the relative-default rules live in `validate-host-path-defaults.ts`. */
const ANCHORED = "/";

/**
 * A module input's `default:` checked against the input's own declaration — the
 * static twin of the kernel's resolution, which validates the default it falls
 * back to and refuses the whole application at boot when it does not fit.
 *
 * Either is read the way the kernel reads it: decoded through each instance
 * type's plain encoding — an Application binding's default as host TEXT's
 * stand-in against the residual schema, a Library's as what the import site
 * builds when its importer supplies nothing, against the rest of its entry.
 *
 * A named shape an entry references is read as the kernel reads it: by its
 * canonical id, resolved in the declaring module's scope, through `shapeOf` —
 * the shape as the configurations judged take it.
 *
 * Entry-module-scoped: a dependency's inputs are its author's to fix.
 */
export function validateInputDefaults(
  manifests: readonly ResourceManifest[],
  scope: InputDefaultsScope,
  shapeOf: (id: string) => Schema | undefined,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const manifest of manifests) {
    if (manifest.kind !== "Telo.Application" && manifest.kind !== "Telo.Library") continue;
    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    const name = typeof metadata.name === "string" ? metadata.name : "";
    if (!scope.rootModules.has(name)) continue;
    for (const block of ["variables", "secrets"] as const) {
      const entries = (manifest as Record<string, unknown>)[block];
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      for (const [key, raw] of Object.entries(entries as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const entry = raw as Record<string, unknown>;
        // A default holding a tag at any depth is never read as a value;
        // `MODULE_PATH_OUTSIDE_RESOURCE` and its siblings report the tag.
        // `default: null` declares that the input may be absent, whatever its type.
        if (entry.default === undefined || entry.default === null || holdsTag(entry.default)) continue;
        const binding = "env" in entry || "arg" in entry;
        const { default: fallback, ...rest } = entry;
        const schema = canonicalInModule(binding ? residualEntrySchema(entry) : rest, name, scope);
        const value = mapTextLeaves(
          decodePlainLiterals(structuredClone(fallback), schema, shapeOf),
          schema,
          (slot, text) => (hostAnchorFor(slot, text) !== undefined ? ANCHORED : text),
          shapeOf,
        );
        const at = {
          resource: { kind: manifest.kind, name },
          filePath: typeof metadata.source === "string" ? metadata.source : undefined,
          path: `${block}.${key}.default`,
        };
        const outcome = validateAgainstSchemaWithShapes(value, schema, shapeOf);
        if (!outcome.finished) {
          out.push({
            severity: DiagnosticSeverity.Error,
            code: SCHEMA_NESTING_EXCEEDED,
            source: SOURCE,
            message: schemaNestingExceededMessage(`${manifest.kind}/${name}`, `the default of ${block}.${key}`, outcome),
            data: { ...at },
          });
          continue;
        }
        for (const issue of outcome.issues) {
          // The rendered issue opens with its instance path, `/` for the whole value.
          const text = issue.message.replace(/^\/ /, "");
          out.push({
            severity: DiagnosticSeverity.Error,
            code: valueTypeRefusalCode(issue) ?? "DEFAULT_INVALID",
            source: SOURCE,
            message:
              `${manifest.kind}/${name}: the default of ${block}.${key} ${text}. ` +
              `A default is the value the input holds when nothing supplies one, so it must ` +
              `satisfy the input's own declaration.`,
            data: { ...at },
          });
        }
      }
    }
    // Every declared port is assigned under a runner, so none may be absent.
    const ports = (manifest as Record<string, unknown>).ports;
    if (manifest.kind === "Telo.Application" && ports && typeof ports === "object" && !Array.isArray(ports)) {
      for (const [key, entry] of Object.entries(ports as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object" || (entry as Record<string, unknown>).default !== null) continue;
        out.push({
          severity: DiagnosticSeverity.Error,
          code: "DEFAULT_INVALID",
          source: SOURCE,
          message:
            `${manifest.kind}/${name}: the default of ports.${key} is null, but a port never admits ` +
            `absence — every declared port is assigned wherever the application runs. Give it a port ` +
            `number, or leave 'default:' out to require one.`,
          data: {
            resource: { kind: manifest.kind, name },
            filePath: typeof metadata.source === "string" ? metadata.source : undefined,
            path: `ports.${key}.default`,
          },
        });
      }
    }
  }
  return out;
}

/** True for the built-in schema's own finding about a port's `default: null`,
 *  which {@link validateInputDefaults} reports as `DEFAULT_INVALID`. */
export function isNullPortDefaultFinding(manifest: ResourceManifest, path: string): boolean {
  if (manifest.kind !== "Telo.Application") return false;
  const match = /^ports\.([^.]+)\.default$/.exec(path);
  const ports = (manifest as Record<string, unknown>).ports as Record<string, Record<string, unknown>> | undefined;
  return !!match && ports?.[match[1]!]?.default === null;
}

function holdsTag(value: unknown): boolean {
  if (isTaggedSentinel(value)) return true;
  if (Array.isArray(value)) return value.some(holdsTag);
  if (value !== null && typeof value === "object") return Object.values(value).some(holdsTag);
  return false;
}
