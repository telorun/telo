import { artifactPath, DEFAULT_MANIFEST_FILENAME } from "@telorun/analyzer";

/**
 * The module-layout rules of a module shipped inside another module's artifact
 * (`kernel/specs/module-artifact.md` §6). Pure path arithmetic over
 * `/`-separated artifact paths; the transport supplies what the manifest layer
 * carries.
 */

const IN_DIRECTORY = `/${DEFAULT_MANIFEST_FILENAME}`;

/** The manifest of the module at `path` inside an artifact: a directory means
 *  its `telo.yaml`, otherwise the file — the rule a relative import follows on
 *  disk. `undefined` when the artifact carries neither. */
export function nestedManifestEntry(
  path: string,
  carries: (entry: string) => boolean,
): string | undefined {
  const inDirectory = `${path}${IN_DIRECTORY}`;
  if (carries(inDirectory)) return inDirectory;
  return carries(path) ? path : undefined;
}

/** The module path a relative import declared in the artifact directory `dir`
 *  names, canonical — `./chat` and `./chat/telo.yaml` name one module. `null`
 *  when the import leaves the artifact root, or names the root's own manifest. */
export function nestedImportPath(dir: string, relative: string): string | null {
  const target = artifactPath(dir, relative);
  if (target === null || target === "" || target === DEFAULT_MANIFEST_FILENAME) return null;
  return target.endsWith(IN_DIRECTORY) ? target.slice(0, -IN_DIRECTORY.length) : target;
}

/** The directory, inside its artifact, of the nested module at `path` whose
 *  manifest file is `manifestFile` — the layer entry, or any path ending in it
 *  (a cached copy mirrors the layer). */
export function nestedModuleDirectory(path: string, manifestFile: string): string {
  const file = manifestFile.replace(/\\/g, "/");
  if (file === `${path}${IN_DIRECTORY}` || file.endsWith(`/${path}${IN_DIRECTORY}`)) return path;
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
