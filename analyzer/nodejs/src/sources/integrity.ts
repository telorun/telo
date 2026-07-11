/** Inline module integrity — the `#sha256-<base64url>` fragment carried on a
 *  remote import ref. Browser-safe: uses Web Crypto (`crypto.subtle`) and
 *  `btoa`, both globals in Node and the browser. No Node built-ins.
 *
 *  The fragment is authoritative across every transport: a source's `read()`
 *  hashes the fetched bytes and compares against it before the manifest is
 *  parsed or cached. A mismatch is a terminal error — never a cache miss. */

/** Only a `#<alg>-<base64url>` suffix is treated as integrity; other `#`
 *  fragments (rare in module refs) pass through untouched. `sha256` is the
 *  only algorithm accepted today; the prefix leaves room to migrate. */
const INTEGRITY_FRAGMENT = /#(sha256-[A-Za-z0-9_+/=-]+)$/;

/** A failed integrity/tamper check — always terminal, never best-effort. A
 *  distinct type so a caller doing best-effort network handling (e.g. the
 *  bundle extractor warning-and-skipping on a fetch blip) can still let a
 *  tamper error propagate rather than swallow it. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

/** Split a trailing integrity fragment off a ref/URL. Returns the bare ref in
 *  `base` (safe to build fetch URLs and cache paths from) and the fragment in
 *  `integrity` (e.g. `sha256-<base64url>`), or `undefined` when absent. */
export function splitIntegrity(ref: string): { base: string; integrity?: string } {
  const match = ref.match(INTEGRITY_FRAGMENT);
  if (!match) return { base: ref };
  return { base: ref.slice(0, match.index), integrity: match[1] };
}

/** Attach an integrity hash to a ref as a `#<alg>-...` fragment. No-op when the
 *  hash is absent/non-string or the ref already carries a fragment (an
 *  author-authored pin is never overwritten). Inverse of `splitIntegrity`;
 *  used to fold the object form's `integrity:` sibling into the source string. */
export function foldIntegrity(source: string, integrity: unknown): string {
  return typeof integrity === "string" && !source.includes("#")
    ? `${source}#${integrity}`
    : source;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Normalize an encoded digest to unpadded base64url so a standard-base64 or
 *  padded input still compares equal to our canonical form. */
function normalizeDigest(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 of `bytes` as unpadded base64url — the canonical inline-hash form. */
export async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer: a Uint8Array may be backed by a
  // SharedArrayBuffer, which `crypto.subtle.digest` does not accept.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return toBase64Url(new Uint8Array(digest));
}

/** Hash `bytes` and compare against `integrity` (`<alg>-<digest>`). Throws a
 *  terminal error on mismatch or an unsupported algorithm. `describe` names the
 *  artifact in the error (e.g. the module ref) so the failure is actionable. */
export async function verifyIntegrity(
  bytes: Uint8Array,
  integrity: string,
  describe: string,
): Promise<void> {
  const dash = integrity.indexOf("-");
  const algorithm = dash > 0 ? integrity.slice(0, dash) : "";
  const expected = dash > 0 ? integrity.slice(dash + 1) : "";
  if (algorithm !== "sha256") {
    throw new IntegrityError(
      `Unsupported integrity algorithm '${algorithm || integrity}' for ${describe}. ` +
        `Only sha256 is supported (sha256-<base64url>).`,
    );
  }
  const actual = await sha256Base64Url(bytes);
  if (actual !== normalizeDigest(expected)) {
    throw new IntegrityError(
      `Integrity check failed for ${describe}: expected sha256-${normalizeDigest(expected)}, ` +
        `got sha256-${actual}. The fetched bytes do not match the recorded hash — ` +
        `the module may have been tampered with or republished.`,
    );
  }
}

/** The single verified network read for remote manifests: fetch `fetchUrl`,
 *  verify the raw bytes against `integrity` (when pinned), and return both the
 *  bytes and the decoded text. The one choke point every network `ManifestSource`
 *  routes through, so verification cannot drift between them. `describe` names
 *  the artifact in error messages. */
export async function verifiedFetch(
  fetchUrl: string,
  integrity: string | undefined,
  describe: string,
): Promise<{ bytes: Uint8Array; text: string }> {
  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch manifest ${describe}: ${response.status} ${response.statusText} (${fetchUrl})`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (integrity) await verifyIntegrity(bytes, integrity, describe);
  return { bytes, text: new TextDecoder().decode(bytes) };
}
