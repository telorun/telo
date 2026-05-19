import type { ResourceManifest } from "@telorun/sdk";
import type { AnalysisDiagnostic } from "./types.js";

interface XTeloOrigin {
  parentKind: string;
  parentName: string;
  pathFromParent: string;
}

function readOrigin(manifest: ResourceManifest | undefined): XTeloOrigin | undefined {
  if (!manifest) return undefined;
  const origin = (manifest.metadata as { xTeloOrigin?: XTeloOrigin } | undefined)?.xTeloOrigin;
  if (
    !origin ||
    typeof origin.parentKind !== "string" ||
    typeof origin.parentName !== "string" ||
    typeof origin.pathFromParent !== "string"
  ) {
    return undefined;
  }
  return origin;
}

/** Diagnostics emitted on synthetic manifests (resources extracted by
 *  `normalizeInlineResources`) carry the synthetic's identity in
 *  `data.resource`, which has no YAML source. Rewrite each such diagnostic
 *  back to the chain root: walk up `metadata.xTeloOrigin` until a manifest
 *  with no origin is reached, and prepend each hop's `pathFromParent` to
 *  `data.path` so position-index lookups against the root doc resolve. */
export function rewriteSyntheticOrigins(
  diagnostics: AnalysisDiagnostic[],
  manifests: ResourceManifest[],
): AnalysisDiagnostic[] {
  const byName = new Map<string, ResourceManifest>();
  for (const m of manifests) {
    const name = m.metadata?.name;
    if (typeof name === "string") byName.set(name, m);
  }

  return diagnostics.map((d) => {
    const data = d.data as
      | { resource?: { kind?: string; name?: string }; path?: string; filePath?: string }
      | undefined;
    if (!data?.resource?.name) return d;

    let current = byName.get(data.resource.name);
    let origin = readOrigin(current);
    if (!origin) return d;

    let accumPath = typeof data.path === "string" ? data.path : "";
    let rootKind: string = origin.parentKind;
    let rootName: string = origin.parentName;

    while (origin) {
      accumPath = accumPath ? `${origin.pathFromParent}.${accumPath}` : origin.pathFromParent;
      rootKind = origin.parentKind;
      rootName = origin.parentName;
      current = byName.get(origin.parentName);
      origin = readOrigin(current);
    }

    const rootFilePath =
      (current?.metadata as { source?: string } | undefined)?.source ?? data.filePath;

    return {
      ...d,
      data: {
        ...data,
        resource: { kind: rootKind, name: rootName },
        filePath: rootFilePath,
        path: accumPath,
      },
    };
  });
}
