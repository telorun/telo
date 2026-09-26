const FILE_URI = /^file:(?:\/\/([^/?#]*))?([^?#]*)/i;
const UNRESERVED = /[A-Za-z0-9\-._~/]/;
const WINDOWS_DRIVE = /^\/([A-Za-z]):(\/|$)/;
const encoder = new TextEncoder();

/** The bytes a path spells, with its `%XX` escapes decoded and everything else
 *  taken as UTF-8 — so `%28` and `(` are the same byte. */
function pathBytes(path: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < path.length; i++) {
    const escape = /^%([0-9A-Fa-f]{2})/.exec(path.slice(i, i + 3));
    if (escape) {
      bytes.push(parseInt(escape[1]!, 16));
      i += 2;
      continue;
    }
    const codePoint = path.codePointAt(i)!;
    const char = String.fromCodePoint(codePoint);
    bytes.push(...encoder.encode(char));
    i += char.length - 1;
  }
  return bytes;
}

/** Bytes percent-encoded except the unreserved characters (and `/` in a
 *  path), with uppercase hex. */
function encode(bytes: number[], keepSlash: boolean): string {
  let out = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    const kept = byte < 0x80 && UNRESERVED.test(char) && (keepSlash || char !== "/");
    out += kept ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * The canonical spelling of a `file:` URI (`@telorun/editor-protocol` § URIs):
 * no query or fragment; an empty authority for a local file (`localhost` is
 * none), a UNC share's host ASCII-lowercased and percent-encoded as the
 * authority (`file:////host/share/…` is `file://host/share/…`); every path
 * byte percent-encoded except the unreserved characters and `/`, with
 * uppercase hex; and, for a local file, a Windows drive as `/<lowercase>%3A/`.
 * Two spellings name one location exactly when their canonical forms are
 * equal. Any other URI is returned unchanged.
 */
export function canonicalUri(uri: string): string {
  const match = FILE_URI.exec(uri);
  if (!match) return uri;
  let hostBytes = pathBytes(match[1] ?? "");
  let bytes = pathBytes(match[2] || "/");
  const slash = 0x2f;
  if (hostBytes.length === 0 && bytes[0] === slash && bytes[1] === slash && bytes[2] !== undefined && bytes[2] !== slash) {
    const end = bytes.indexOf(slash, 2);
    hostBytes = end === -1 ? bytes.slice(2) : bytes.slice(2, end);
    bytes = end === -1 ? [slash] : bytes.slice(end);
  }
  hostBytes = hostBytes.map((b) => (b >= 0x41 && b <= 0x5a ? b + 0x20 : b));
  let host = encode(hostBytes, false);
  if (host === "localhost") host = "";
  let path = encode(bytes, true);
  if (host === "") {
    const drive = WINDOWS_DRIVE.exec(new TextDecoder().decode(new Uint8Array(bytes)));
    if (drive) path = `/${drive[1]!.toLowerCase()}%3A${path.slice("/X%3A".length)}`;
  }
  if (!path.startsWith("/")) path = `/${path}`;
  return `file://${host}${path}`;
}
