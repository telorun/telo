import { hostAnchorOf, isAbsoluteHostPath, valueTypeOf, type ResourceManifest } from "@telorun/sdk";
import { hostPathRelativeMessage } from "./value-type-keyword.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** Keys whose value is a schema, or a map / list of schemas, below a node. */
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions"] as const;
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf"] as const;
const SCHEMA_NODES = ["items", "additionalProperties", "not", "if", "then", "else"] as const;

/**
 * A relative `default:` at a `Telo.HostPath` node, reported where it is WRITTEN.
 *
 * A host path is anchored only where the host supplies it — an Application
 * variable's env value or the `default:` standing in for one. A kind's schema
 * default is text the kind's author wrote, and resolving it against whatever
 * directory each consumer happened to start in would give one declaration a
 * different file in every runner, test and packaged app; so it is refused, at
 * the kind, rather than at every consumer that leaves the field out. The same
 * holds for a Library's variable, whose value comes from the importer's
 * manifest rather than from the host.
 *
 * Entry-module-scoped: a dependency's kinds are its author's to fix.
 */
export function validateHostPathDefaults(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const manifest of manifests) {
    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    const name = typeof metadata.name === "string" ? metadata.name : "";
    const owner =
      typeof metadata.module === "string"
        ? metadata.module
        : manifest.kind === "Telo.Application" || manifest.kind === "Telo.Library"
          ? name
          : undefined;
    if (owner !== undefined && !rootModules.has(owner)) continue;

    const report = (path: string, value: string, schema: Record<string, unknown>, why: string) =>
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "HOST_PATH_RELATIVE",
        source: SOURCE,
        message:
          `${manifest.kind}/${name}: default '${value}' at '${path}' ` +
          `${hostPathRelativeMessage(valueTypeOf(schema)!)}. ${why}`,
        data: {
          resource: { kind: manifest.kind, name },
          filePath: typeof metadata.source === "string" ? metadata.source : undefined,
          path,
        },
      });

    if (manifest.kind === "Telo.Definition" || manifest.kind === "Telo.Abstract") {
      walk((manifest as { schema?: unknown }).schema, "schema", (path, value, schema) =>
        report(
          path,
          value,
          schema,
          "A kind's default is resolved against nothing — drop it and make the field " +
            "required, so the importing application supplies it from its own host-path variable.",
        ),
      );
    }
    if (manifest.kind === "Telo.Library") {
      for (const block of ["variables", "secrets"] as const) {
        const entries = (manifest as Record<string, unknown>)[block];
        if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
        for (const [key, entry] of Object.entries(entries as Record<string, unknown>)) {
          walk(entry, `${block}.${key}`, (path, value, schema) =>
            report(
              path,
              value,
              schema,
              "A library's value comes from its importer's manifest, not from the host, so " +
                "only the importing application can resolve a relative one — drop the default.",
            ),
          );
        }
      }
    }
  }
  return out;
}

function walk(
  node: unknown,
  path: string,
  found: (path: string, value: string, schema: Record<string, unknown>) => void,
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const schema = node as Record<string, unknown>;
  if (
    hostAnchorOf(schema) !== undefined &&
    typeof schema.default === "string" &&
    !isAbsoluteHostPath(schema.default)
  ) {
    found(`${path}.default`, schema.default, schema);
  }
  for (const key of SCHEMA_MAPS) {
    const map = schema[key];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [name, child] of Object.entries(map as Record<string, unknown>)) {
      walk(child, `${path}.${key}.${name}`, found);
    }
  }
  for (const key of SCHEMA_LISTS) {
    const list = schema[key];
    if (Array.isArray(list)) list.forEach((child, i) => walk(child, `${path}.${key}[${i}]`, found));
  }
  for (const key of SCHEMA_NODES) walk(schema[key], `${path}.${key}`, found);
}
