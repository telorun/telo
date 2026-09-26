/**
 * Studio's workspace paths as the `file:` URIs the language engine speaks.
 *
 * Every workspace adapter keys files by an absolute POSIX-style path: the real
 * path on disk in the desktop build, and a virtual one in the browser — the
 * picked directory mounted at `/<directory name>` (File System Access) or the
 * fixed `/workspace` root (local storage). Each maps to the `file:` URI of that
 * path, so a browser workspace's `app/telo.yaml` is `file:///workspace/app/telo.yaml`
 * and the engine resolves owners and relative imports against it exactly as it
 * does on disk. The spelling here is not the canonical one (it leaves
 * `! ' ( ) *` bare); it does not need to be, because the language host and the
 * engine compare `file:` URIs only in their canonical form
 * (`@telorun/editor-protocol` § URIs) and Monaco models carry their own
 * spelling.
 */

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

export function pathToFileUri(path: string): string {
  const posix = WINDOWS_DRIVE.test(path) ? `/${path.replace(/\\/g, "/")}` : path;
  if (!posix.startsWith("/")) throw new Error(`'${path}' is not an absolute workspace path.`);
  return `file://${posix.split("/").map(encodeURIComponent).join("/")}`;
}

/** The workspace path a `file:` URI names; any other URI (`oci://`, `https://`)
 *  is returned as written — that is how studio keys a remote module. */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file:")) return uri;
  const path = decodeURIComponent(new URL(uri).pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}
