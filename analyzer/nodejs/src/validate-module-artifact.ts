import type { ResourceManifest } from "@telorun/sdk";

import { parseLayerIndex, LayerIndexError } from "./artifact-layer-index.js";
import {
  ArtifactSelectorError,
  PLATFORM_AXES,
  selectorFromQualifiers,
} from "./artifact-selector.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * Static validation of the module-artifact surface — `kernel/specs/module-artifact.md`.
 *
 * Everything here is decidable from the manifest text alone, and every case would
 * otherwise surface on a *consumer's* machine at controller-resolve time (or, worse,
 * not at all). That is the whole argument: an author who mistypes a platform axis
 * gets a platform-neutral candidate, publish emits one layer, and every host
 * happily loads a binary built for one architecture — silently, forever.
 *
 * Two checks. Note that several candidates *sharing* one selector is not among
 * them: a controller layer holds the entry points of every candidate with that
 * selector (spec §1), which is what every module with two `js` controllers relies
 * on.
 *
 * 1. **Controller selector qualifiers.** `os` / `arch` / `libc` / `siblings` are
 *    authored surface. An unknown qualifier is reported rather than ignored, since
 *    ignoring is what makes a typo invisible; an invalid value is reported here
 *    instead of throwing from the loader later.
 * 2. **The published layer index.** The owner doc's JSON Schema covers shape; the
 *    semantic rules — controller-requires-selector, singletons carry none, no
 *    duplicate selector, the token grammar (`os: Linux` passes the schema and
 *    throws at runtime) — live in the parser, so run it.
 */
export function validateModuleArtifact(manifests: ResourceManifest[]): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const manifest of manifests) {
    validateLayerIndex(manifest, out);
    validateControllerSelectors(manifest, out);
  }
  return out;
}

const KNOWN_QUALIFIERS = new Set<string>(["path", "siblings", ...PLATFORM_AXES]);

/** `pkg:telo/local/<format>?…` — the bundled-controller delivery mode. Parsed by
 *  hand rather than with a PURL library: the analyzer must stay browser-safe and
 *  dependency-light, and the only thing needed here is the qualifier map. */
function parseBundledPurl(
  purl: string,
): { format: string; qualifiers: Record<string, string> } | null {
  if (!purl.startsWith("pkg:telo/local/")) return null;
  const withoutFragment = purl.split("#")[0];
  const [head, query = ""] = withoutFragment.split("?");
  const format = head.slice("pkg:telo/local/".length);
  if (format === "") return null;
  const qualifiers: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    qualifiers[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
  }
  return { format, qualifiers };
}

function validateControllerSelectors(
  manifest: ResourceManifest,
  out: AnalysisDiagnostic[],
): void {
  const controllers = (manifest as { controllers?: unknown }).controllers;
  if (!Array.isArray(controllers)) return;
  const metadata = manifest.metadata as
    | { name?: string; module?: string; source?: string }
    | undefined;
  const name = metadata?.name;
  const filePath = metadata?.source;
  const resource = { kind: manifest.kind, name };

  controllers.forEach((candidate, index) => {
    if (typeof candidate !== "string") return;
    const parsed = parseBundledPurl(candidate);
    if (!parsed) return;
    const at = `controllers[${index}]`;

    const unknown = Object.keys(parsed.qualifiers).filter((k) => !KNOWN_QUALIFIERS.has(k));
    for (const key of unknown) {
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "CONTROLLER_UNKNOWN_QUALIFIER",
        source: SOURCE,
        message:
          `${manifest.kind}/${name ?? "(unnamed)"}: bundled controller qualifier '${key}' is not ` +
          `recognized. Known qualifiers: ${[...KNOWN_QUALIFIERS].sort().join(", ")}. An ` +
          `unrecognized platform axis is ignored, which would make this candidate ` +
          `platform-neutral and offer a single-platform binary to every host.`,
        data: { resource, filePath, path: `${at}?${key}` },
      });
    }

    // Validate the selector; the value is not otherwise needed here, since
    // candidates sharing a selector legitimately share a layer.
    try {
      selectorFromQualifiers(parsed.format, parsed.qualifiers, candidate);
    } catch (err) {
      if (!(err instanceof ArtifactSelectorError)) throw err;
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "CONTROLLER_INVALID_SELECTOR",
        source: SOURCE,
        message: `${manifest.kind}/${name ?? "(unnamed)"}: ${err.message}`,
        data: { resource, filePath, path: at },
      });
    }
  });
}

function validateLayerIndex(manifest: ResourceManifest, out: AnalysisDiagnostic[]): void {
  if (manifest.kind !== "Telo.Application" && manifest.kind !== "Telo.Library") return;
  const layers = (manifest as { layers?: unknown }).layers;
  if (layers === undefined) return;
  const metadata = manifest.metadata as { name?: string; source?: string } | undefined;
  const name = metadata?.name;
  try {
    parseLayerIndex(layers);
  } catch (err) {
    if (!(err instanceof LayerIndexError) && !(err instanceof ArtifactSelectorError)) throw err;
    out.push({
      severity: DiagnosticSeverity.Error,
      code: "INVALID_LAYER_INDEX",
      source: SOURCE,
      message: `${manifest.kind}/${name ?? "(unnamed)"}: ${err.message}`,
      data: {
        resource: { kind: manifest.kind, name },
        filePath: metadata?.source,
        path: "layers",
      },
    });
  }
}
