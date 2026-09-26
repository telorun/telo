/**
 * Where a document lives, in the two spellings the engine deals in.
 *
 * LSP and the `telo/*` requests speak URIs. The analyzer speaks SOURCES: a local
 * file is its absolute path (the form `telo check` reports and every host-path
 * rule is written against; a file on a UNC share is `//host/share/…`), a remote
 * module keeps its `oci://` / `https://` spelling. The engine converts at its edges and resolves relative paths itself,
 * as pure string operations — no filesystem, no `node:path`.
 */

const REMOTE = /^(oci|https?):\/\//;
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(.*)$/;

/** True for a module read from a registry or the web, as opposed to a document
 *  in the workspace the host serves. */
export function isRemoteSource(source: string): boolean {
  return REMOTE.test(source);
}

const FILE_URI = /^file:(?:\/\/([^/?#]*))?([^?#]*)/i;

/** The analyzer source a URI names: a `file:` URI becomes its decoded absolute
 *  path — `//host/share/…` for a UNC share, whose host is kept lowercased
 *  (`file:////host/share/…` names the same share) and `localhost` is no host —
 *  anything else is kept as written. */
export function sourceOfUri(uri: string): string {
  const match = FILE_URI.exec(uri);
  if (!match) return uri;
  let host = decodeURIComponent(match[1] ?? "");
  let path = decodeURIComponent(match[2] || "/");
  if (host === "" && /^\/\/[^/]/.test(path)) {
    const end = path.indexOf("/", 2);
    host = end === -1 ? path.slice(2) : path.slice(2, end);
    path = end === -1 ? "/" : path.slice(end);
  }
  host = host.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (!path.startsWith("/")) path = `/${path}`;
  return host === "" || host === "localhost" ? path : `//${host}${path}`;
}

/** A path segment's UTF-8 bytes percent-encoded, everything but the unreserved
 *  characters escaped with uppercase hex — `encodeURIComponent` leaves
 *  `! ' ( ) *` alone, which the canonical form escapes. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The canonical `file:` URI of an analyzer source (`@telorun/editor-protocol`
 *  § URIs: a UNC share's host lowercased and percent-encoded as the authority,
 *  otherwise an empty authority and a Windows drive written `/<lowercase>%3A/`)
 *  — the inverse of {@link sourceOfUri}. A remote source is its own URI. */
export function uriOfSource(source: string): string {
  if (!source.startsWith("/")) return source;
  const unc = /^\/\/([^/]+)(\/.*)?$/.exec(source);
  if (unc) {
    const path = unc[2] ?? "/";
    return `file://${encodeSegment(unc[1]!.replace(/[A-Z]/g, (c) => c.toLowerCase()))}${path.split("/").map(encodeSegment).join("/")}`;
  }
  const path = source.replace(/^\/([A-Za-z]):(?=\/|$)/, (drive, letter: string) => `/${letter.toLowerCase()}:`);
  return `file://${path.split("/").map(encodeSegment).join("/")}`;
}

/** A document URI in the canonical spelling the engine emits, whatever
 *  spelling the host used. */
export function canonicalDocumentUri(uri: string): string {
  return uriOfSource(sourceOfUri(uri));
}

/** True when a source is a local absolute path, i.e. a document the host has a
 *  buffer for. */
export function isLocalPath(source: string): boolean {
  return source.startsWith("/");
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

function splitSource(source: string): { prefix: string; path: string } {
  const match = SCHEME.exec(source);
  if (match) return { prefix: `${match[1]}://${match[2]}`, path: match[3] || "/" };
  // A UNC share: its `//host` is not a path segment to normalize away.
  const unc = /^(\/\/[^/]+)(.*)$/.exec(source);
  if (unc) return { prefix: unc[1]!, path: unc[2] || "/" };
  return { prefix: "", path: source };
}

/** The directory holding the file `source` names. */
export function dirnameOf(source: string): string {
  const { prefix, path } = splitSource(source);
  const cut = path.lastIndexOf("/");
  return `${prefix}${cut <= 0 ? "/" : path.slice(0, cut)}`;
}

export function basenameOf(source: string): string {
  const { path } = splitSource(source);
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `relative` resolved against the DIRECTORY `dir`. */
export function joinSource(dir: string, relative: string): string {
  if (isRemoteSource(dir) && !dir.startsWith("oci:")) {
    return new URL(relative, dir.endsWith("/") ? dir : `${dir}/`).href;
  }
  const { prefix, path } = splitSource(dir);
  const joined = relative.startsWith("/") ? relative : `${path}/${relative}`;
  return `${prefix}${normalizePath(joined)}`;
}

/**
 * `relative` resolved against the file `base` names — the rule every
 * `ManifestSource.resolveRelative` implements. An `oci://` base resolves its
 * repository path as a directory and drops the reference, which is how the
 * kernel's OCI transport resolves a sibling module; a non-relative spec against
 * it is already absolute.
 */
export function resolveAgainst(base: string, relative: string): string {
  if (base.startsWith("oci://")) {
    if (!relative.startsWith(".") && !relative.startsWith("/")) return relative;
    const withoutPin = base.replace(/#.*$/, "");
    const at = withoutPin.lastIndexOf("@");
    const bare = at > "oci://".length ? withoutPin.slice(0, at) : withoutPin;
    const resolved = new URL(relative, `https://${bare.slice("oci://".length)}/`);
    return `oci://${resolved.host}${resolved.pathname.replace(/\/+$/, "")}`;
  }
  if (isRemoteSource(base)) {
    const dir = base.endsWith("/") ? base : base.slice(0, base.lastIndexOf("/") + 1);
    return new URL(relative, dir).href;
  }
  return joinSource(dirnameOf(base), relative);
}
