import * as path from "path";
import { pathToFileURL } from "url";
import { RuntimeError } from "@telorun/sdk";
import type { ModuleArtifact } from "./bundle/module-artifact.js";

/** The slice of the kernel this module needs: a module's artifact, when it has
 *  one. A module already on disk has none — that is normal, not an error. */
export interface ModuleArtifactLookup {
  getModuleArtifact(source: string | undefined): ModuleArtifact | undefined;
}

/**
 * Resolve a module-relative reference against the declaring module's own
 * directory, materializing the layers that could carry it on first use.
 *
 * A URI, not a filesystem path: the SDK is cross-runtime, and a path is only
 * what *this* kernel happens to return for a module whose files are local. An
 * already-absolute URI (one with a scheme) passes through untouched; a bare
 * absolute filesystem path is returned as a `file://` URI rather than being
 * rebased onto the module directory.
 *
 * Shared by `ctx.resolveModuleFile` and by `!include-*` resolution, so a file
 * reached by a controller and a file embedded by a tag are located by one rule
 * — including which layers get materialized on the way.
 */
export async function resolveModuleFileUri(
  relative: string,
  source: string,
  lookup: ModuleArtifactLookup,
): Promise<string> {
  // An absolute URI names its own location; a bare absolute path is already
  // resolved and must not be rebased onto the module directory.
  if (/^[a-z][a-z0-9+.-]*:/i.test(relative)) return relative;
  if (path.isAbsolute(relative)) return pathToFileURL(relative).href;

  const artifact = lookup.getModuleArtifact(source);
  if (artifact) {
    // Both the `assets` layer and `common` — the sink rule puts a file the
    // author did not claim via `assets:` into `common`, and a module that ships
    // static files with no bundled controller has no other route to its payload.
    // Fetching only assets would leave such a module resolving into an empty
    // directory.
    await artifact.materializeModuleFiles();
    return new URL(relative, pathToFileURL(path.join(artifact.directory, "/")).href).href;
  }
  // No artifact means no payload to fetch. That is normal for a module already
  // on disk (development) or one that ships no files — but for a module reached
  // over a non-local scheme it means the artifact carries no layer index, i.e. it
  // predates layers. Raise the actionable error here rather than leaving each
  // caller to invent its own message from a URI it cannot open.
  if (!source.startsWith("file://") && !path.isAbsolute(source)) {
    throw new RuntimeError(
      "ERR_MODULE_FILES_UNAVAILABLE",
      `Cannot resolve '${relative}' against module '${source}': the module's artifact ` +
        `carries no layer index, so its files cannot be located. It was published by an ` +
        `older Telo that wrote a single-blob artifact — republish the module, or import it ` +
        `from a local path during development.`,
    );
  }
  // Local module: resolve against the manifest URL, the same rule `include:`
  // and sibling imports follow.
  const base = source.startsWith("file://") ? source : pathToFileURL(source).href;
  return new URL(relative, base).href;
}
