import type { ResourceManifest } from "@telorun/sdk";

import { parseLayerIndex, LayerIndexError } from "./artifact-layer-index.js";
import {
  ArtifactSelectorError,
  PLATFORM_AXES,
  selectorFromQualifiers,
  selectorKey,
} from "./artifact-selector.js";
import { readLibraryCandidates, type LibraryCandidate } from "./module-library.js";
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
    validateLibraryCandidates(manifest, out);
  }
  return out;
}

/**
 * The `exports.code:` block on a `Telo.Library` doc.
 *
 * Reported here rather than left to the loader for the same reason a controller
 * selector is: an entry that cannot be read names no entry point, so a
 * consumer's bundle falls back to *inlining* the library — the module scope
 * duplication this whole mechanism exists to remove — and it does so silently, on
 * someone else's machine.
 */
function validateLibraryCandidates(manifest: ResourceManifest, out: AnalysisDiagnostic[]): void {
  // `Telo.Library` only. An application is a root with no importer, so it has no
  // `exports:` block at all — and its schema is `additionalProperties: false`,
  // so AJV already rejects the key by name in this same pass. A second
  // diagnostic on that node would be two squiggles saying one thing.
  if (manifest.kind !== "Telo.Library") return;
  const metadata = manifest.metadata as { name?: string; source?: string } | undefined;
  const { candidates, problems } = readLibraryCandidates(manifest);
  const resource = { kind: manifest.kind, name: metadata?.name };

  for (const problem of problems) {
    out.push({
      severity: DiagnosticSeverity.Error,
      code: "LIBRARY_CANDIDATE_INVALID",
      source: SOURCE,
      message: `Telo.Library/${metadata?.name ?? "(unnamed)"}: ${problem.origin}: ${problem.detail}`,
      data: { resource, filePath: metadata?.source, path: "exports/code" },
    });
  }

  // One specifier per selector: two candidates of one format claiming the same
  // specifier leave the resolution ambiguous, and two specifiers for one format
  // mean a consumer's import resolves by whichever candidate is read first.
  const seen = new Map<string, LibraryCandidate>();
  for (const candidate of candidates) {
    const key = selectorKey(candidate.selector);
    const first = seen.get(key);
    if (first) {
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "LIBRARY_CANDIDATE_DUPLICATE",
        source: SOURCE,
        message:
          `Telo.Library/${metadata?.name ?? "(unnamed)"}: two 'exports.code' entries declare the ` +
          `selector ${key} ('${first.specifier}' and '${candidate.specifier}'). A module has one ` +
          `entry point per format — which is what makes "one specifier, one module scope" true.`,
        data: { resource, filePath: metadata?.source, path: "exports/code" },
      });
      continue;
    }
    seen.set(key, candidate);
  }
}

/** `local_path` names the source `path=` was built from, so a working copy runs
 *  with no build step. It is inert in a published artifact — which ships no
 *  `src/` — and contributes nothing to the selector, so it never affects which
 *  layer a host fetches. */
const KNOWN_QUALIFIERS = new Set<string>(["path", "local_path", "siblings", ...PLATFORM_AXES]);

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
