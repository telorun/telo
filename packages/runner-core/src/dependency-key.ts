import { parseAllDocuments } from "yaml";

import type { RunBundle } from "./contract.js";

/**
 * The inputs that determine a session's baked dependency layer — everything
 * `telo install` would resolve into `.telo/{manifests,npm}`, and nothing about
 * resource bodies or CEL. A backend that prebuilds a per-app image keys the
 * image tag on this so a body-only edit reuses the image while an import or
 * controller change rebuilds it.
 *
 * Derived by a SHALLOW static parse of the in-memory bundle — no graph load, no
 * network, no archive. Exact import versions pin the transitive closure, so the
 * authored `imports:` + body-declared controllers are sufficient.
 *
 * Assumes every file in the bundle is reachable from the entry (true for
 * editor / control-plane-produced bundles, which carry exactly the app's
 * files). It scans ALL `Telo.Definition` docs rather than following the entry's
 * include/import graph — cheaper, and erring toward over-inclusion only ever
 * busts the cache more eagerly. The one unsound case is a bundle carrying an
 * orphan controller-bearing Definition that `telo install` would NOT bake (not
 * reachable from this entry) yet another entry with the same closure WOULD: they
 * could share a tag whose image lacks that controller. Not reachable via the
 * editor; revisit (anchor to the include graph) if bundles ever carry unreachable
 * Definition files.
 */
export interface DependencyKey {
  /** Sorted `imports:` source strings from every module doc. */
  importSources: string[];
  /** Sorted controller PURLs declared by inline `Telo.Definition` docs. */
  controllerLocators: string[];
  /**
   * True when a `Telo.Definition` resolves its controller from bundle-local
   * source (`local_path`), or a file failed to parse. In either case the dep
   * key alone can't capture a controller change, so the caller MUST also fold
   * the full bundle contents into the tag (safe fallback to content-keying).
   */
  fullContentFallback: boolean;
}

function asModuleKind(kind: unknown): boolean {
  return kind === "Telo.Application" || kind === "Telo.Library";
}

/** Pull `{ source }` out of an `imports:` map value (bare string or object). */
function importSourceOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const source = (value as { source?: unknown }).source;
    if (typeof source === "string") return source;
  }
  return undefined;
}

export function extractDependencyKey(bundle: RunBundle): DependencyKey {
  const importSources = new Set<string>();
  const controllerLocators = new Set<string>();
  let fullContentFallback = false;

  for (const file of bundle.files) {
    let docs;
    try {
      docs = parseAllDocuments(file.contents);
    } catch {
      // Unparseable file — we can't know what it declares, so fall back to
      // hashing the whole bundle rather than risk an under-specified key.
      fullContentFallback = true;
      continue;
    }
    for (const doc of docs) {
      if (doc.errors.length > 0) {
        fullContentFallback = true;
        continue;
      }
      const value = doc.toJS() as Record<string, unknown> | null;
      if (!value || typeof value !== "object") continue;
      const kind = value.kind;

      if (asModuleKind(kind) && value.imports && typeof value.imports === "object") {
        for (const entry of Object.values(value.imports as Record<string, unknown>)) {
          const source = importSourceOf(entry);
          if (source) importSources.add(source);
        }
      }

      if (kind === "Telo.Definition") {
        const controllers = value.controllers;
        if (Array.isArray(controllers)) {
          for (const c of controllers) {
            if (typeof c === "string") controllerLocators.add(c);
          }
        }
        // A bundle-local controller's source lives in the body; the PURL/path
        // can't capture an edit to it, so force full-content keying.
        if (typeof value.local_path === "string") fullContentFallback = true;
      }
    }
  }

  return {
    importSources: [...importSources].sort(),
    controllerLocators: [...controllerLocators].sort(),
    fullContentFallback,
  };
}
