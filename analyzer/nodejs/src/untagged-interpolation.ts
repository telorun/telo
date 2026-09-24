import type { ResourceManifest } from "@telorun/sdk";
import { interpolationShape, isTaggedSentinel } from "@telorun/templating";
import type { ModuleDocuments } from "./module-documents.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** What both halves say about a plain string still holding `${{`. */
export function untaggedInterpolationMessage(path: string): string {
  return (
    `${path ? `'${path}' is` : "A value is"} a plain string holding '\${{', which is never evaluated. ` +
    `Untagged interpolation is a legacy spelling the 'untagged-interpolation' migration rewrites ` +
    `(a lone hole to !cel, text with holes to !interpolate); run 'telo migrate' to apply it, ` +
    `or tag the value !literal if the text is meant literally.`
  );
}

/**
 * A plain string holding `${{` anywhere in a manifest — `UNTAGGED_INTERPOLATION`,
 * the static twin of precompile's `ERR_UNTAGGED_INTERPOLATION`.
 *
 * Every resolved consumer loads with migrations, which rewrite the spelling
 * before this pass runs, so it reports only a tree read without them — or a
 * `${{` no hole can be read out of, which the migration leaves untouched.
 *
 * Reported for EVERY module, because the kernel refuses one at load wherever it
 * is: an entry module's own at its line, a dependency's at the consumer's import
 * of it — the one line the consumer can act on — since a library's internal
 * resources reach analysis only through `moduleDocuments`.
 */
export function validateUntaggedInterpolation(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
  moduleDocuments: readonly ModuleDocuments[] = [],
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const manifest of manifests) {
    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    const name = typeof metadata.name === "string" ? metadata.name : "";
    const owner = ownerModule(manifest);
    if (owner !== undefined && !rootModules.has(owner)) continue;
    walk(manifest, "", (path) =>
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "UNTAGGED_INTERPOLATION",
        source: SOURCE,
        message: `${manifest.kind}/${name}: ${untaggedInterpolationMessage(path)}`,
        data: {
          resource: { kind: manifest.kind, name },
          filePath: typeof metadata.source === "string" ? metadata.source : undefined,
          path,
        },
      }),
    );
  }

  for (const library of moduleDocuments) {
    if (rootModules.has(library.module)) continue;
    const sites: string[] = [];
    for (const manifest of library.manifests) {
      const name = String((manifest.metadata as { name?: unknown } | undefined)?.name ?? "");
      walk(manifest, "", (path) => sites.push(`${manifest.kind}/${name} '${path}'`));
    }
    if (sites.length === 0) continue;
    const message =
      `the imported library '${library.module}' holds a plain string with '\${{' that no hole ` +
      `can be read out of (${sites.join(", ")}), so it fails to load with ERR_UNTAGGED_INTERPOLATION. ` +
      `It is the library's to fix; import a version that writes it as !interpolate or !literal.`;
    const imports = importsOf(manifests, library.module, rootModules);
    if (imports.length === 0) {
      const first = library.manifests[0];
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "UNTAGGED_INTERPOLATION",
        source: SOURCE,
        message: `Telo.Library/${library.module}: ${message}`,
        data: {
          filePath: (first?.metadata as { source?: string } | undefined)?.source,
          path: "",
        },
      });
      continue;
    }
    for (const imp of imports) {
      const metadata = imp.metadata as Record<string, unknown>;
      const alias = String(metadata.name ?? "");
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "UNTAGGED_INTERPOLATION",
        source: SOURCE,
        message: `Telo.Import/${alias}: ${message}`,
        data: {
          resource: { kind: imp.kind, name: alias },
          filePath: typeof metadata.source === "string" ? metadata.source : undefined,
          path: "source",
        },
      });
    }
  }
  return out;
}

function ownerModule(manifest: ResourceManifest): string | undefined {
  const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata.module === "string") return metadata.module;
  return manifest.kind === "Telo.Application" || manifest.kind === "Telo.Library"
    ? (metadata.name as string | undefined)
    : undefined;
}

/** The entry's own imports that reach `module`. */
function importsOf(
  manifests: readonly ResourceManifest[],
  module: string,
  rootModules: ReadonlySet<string>,
): ResourceManifest[] {
  return manifests.filter((m) => {
    if (m.kind !== "Telo.Import") return false;
    const metadata = (m.metadata ?? {}) as Record<string, unknown>;
    const owner = ownerModule(m);
    return metadata.resolvedModuleName === module && (owner === undefined || rootModules.has(owner));
  });
}

function walk(value: unknown, path: string, report: (path: string) => void): void {
  if (typeof value === "string") {
    if (interpolationShape(value) !== "none") report(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, report));
    return;
  }
  if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
  if ((value as { __compiled?: unknown }).__compiled) return;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    walk(v, path ? `${path}.${k}` : k, report);
  }
}
