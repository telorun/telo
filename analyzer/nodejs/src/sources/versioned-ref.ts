import { splitIntegrity } from "./integrity.js";
import { OCI_SCHEME } from "./oci-ref.js";

/** A module ref split into the parts an upgrade needs: the version-independent
 *  ref, the version segment it currently names, and any inline pin. */
export interface ParsedVersionedRef {
  /** The ref with its `@version` segment and integrity fragment removed —
   *  `oci://ghcr.io/telorun/timer`. This is the identity a version list is keyed
   *  by (the hub registers modules under exactly this form). */
  baseRef: string;
  /** The version segment, raw — an OCI tag or an OCI digest reference
   *  (`sha256:…`). The caller applies its own SemVer check. */
  version: string;
  /** Telo's inline `sha256-<base64url>` pin, when the ref carried one. */
  integrity?: string;
}

/** Split a versioned module ref. Returns `null` when the ref names no
 *  upgradeable version — a local path, a bare `https://` URL, or an OCI ref
 *  with no explicit reference (an implicit `latest` is not a pin).
 *
 *  Browser-safe: this is the *grammar* half of an upgrade, shared by the kernel
 *  transports (whose `refVersion` / `withVersion` delegate here) and the editor,
 *  which cannot use a transport at all — the *network* half (enumerating
 *  versions) is scheme-specific and stays behind `Transport.listVersions` on
 *  Node and the hub's `/module/versions` in the browser.
 *
 *  It is NOT transport-neutral: `oci://` is the only versionable grammar, named
 *  literally below. That was equally true when the registry ref was the second
 *  branch, and a third scheme still means editing this file — the versionable
 *  set would have to become data the transports contribute before that claim
 *  could be made honestly. */
export function parseVersionedRef(ref: string): ParsedVersionedRef | null {
  const { base, integrity } = splitIntegrity(ref);
  const at = versionSeparator(base);
  if (at === null) return null;
  const version = base.slice(at + 1);
  if (!version) return null;
  return { baseRef: base.slice(0, at), version, integrity };
}

/** `ref` rewritten to name `version`, dropping any integrity fragment (the
 *  caller re-pins the result). Appends the version when the ref carries none —
 *  an untagged `oci://host/repo` is still a versionable address.
 *
 *  Throws when the ref's grammar has no version segment at all — a relative
 *  path, a bare `https://` URL. Producing `../lib@0.4.0` for those would write
 *  a ref nothing can resolve, so this fails where the transport-specific parser
 *  it replaced (`parseOciRef`) also failed. */
export function withRefVersion(ref: string, version: string): string {
  const { base } = splitIntegrity(ref);
  if (!isVersionableRef(base)) {
    throw new Error(
      `Cannot set a version on '${ref}' — only oci:// refs carry a version segment.`,
    );
  }
  const at = versionSeparator(base);
  return `${at === null ? base : base.slice(0, at)}@${version}`;
}

/** True when `base` is written in a grammar that carries a version segment — a
 *  relative/absolute path and a `file:`/`https://` URL are not. */
function isVersionableRef(base: string): boolean {
  // A host alone is not addressable; the repo path is what carries a version.
  return base.startsWith(OCI_SCHEME) && base.indexOf("/", OCI_SCHEME.length) > OCI_SCHEME.length;
}

/** Index of the `@` that separates the version, or `null` when the ref names
 *  none. Split on the LAST `@` so a digest reference (`repo@sha256:…`) keeps
 *  everything before it as the ref. */
function versionSeparator(base: string): number | null {
  if (!isVersionableRef(base)) return null;
  const at = base.lastIndexOf("@");
  return at > OCI_SCHEME.length ? at : null;
}
