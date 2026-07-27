import { splitIntegrity } from "./integrity.js";
import { isRegistryRef } from "./module-ref.js";
import { OCI_SCHEME } from "./oci-ref.js";

/** A module ref split into the parts an upgrade needs: the version-independent
 *  ref, the version segment it currently names, and any inline pin. */
export interface ParsedVersionedRef {
  /** The ref with its `@version` segment and integrity fragment removed —
   *  `std/run`, `oci://ghcr.io/telorun/timer`. This is the identity a version
   *  list is keyed by (the hub registers modules under exactly this form). */
  baseRef: string;
  /** The version segment, raw — a registry `@version`, an OCI tag, or an OCI
   *  digest reference (`sha256:…`). The caller applies its own SemVer check. */
  version: string;
  /** Telo's inline `sha256-<base64url>` pin, when the ref carried one. */
  integrity?: string;
}

/** Split a versioned module ref. Returns `null` when the ref names no
 *  upgradeable version — a local path, a bare `https://` URL, or an OCI ref
 *  with no explicit reference (an implicit `latest` is not a pin).
 *
 *  Browser-safe and transport-neutral: this is the *grammar* half of an
 *  upgrade, shared by the kernel transports (whose `refVersion` / `withVersion`
 *  delegate here) and the editor, which cannot use a transport at all — the
 *  *network* half (enumerating versions) is scheme-specific and stays behind
 *  `Transport.listVersions` on Node and the hub's `/module/versions` in the
 *  browser. */
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
 *  a ref nothing can resolve, so this fails where the transport-specific
 *  parsers it replaced (`parseOciRef` / `parseModuleRef`) also failed. */
export function withRefVersion(ref: string, version: string): string {
  const { base } = splitIntegrity(ref);
  if (refGrammar(base) === null) {
    throw new Error(
      `Cannot set a version on '${ref}' — only registry (namespace/name@version) ` +
        `and oci:// refs carry a version segment.`,
    );
  }
  const at = versionSeparator(base);
  return `${at === null ? base : base.slice(0, at)}@${version}`;
}

/** Which versionable ref grammar `base` is written in, or `null` when it is
 *  neither — a relative/absolute path, a `file:`/`https://` URL. */
function refGrammar(base: string): "oci" | "registry" | null {
  if (base.startsWith(OCI_SCHEME)) {
    // A host alone is not addressable; the repo path is what carries a version.
    return base.indexOf("/", OCI_SCHEME.length) > OCI_SCHEME.length ? "oci" : null;
  }
  // `isRegistryRef` requires the `@`, so a version-less `std/console` is not a
  // registry ref by this test — matching `parseModuleRef`, which throws on it.
  return isRegistryRef(base) ? "registry" : null;
}

/** Index of the `@` that separates the version, or `null` when the ref names
 *  none. Split on the LAST `@` so a digest reference (`repo@sha256:…`) keeps
 *  everything before it as the ref. */
function versionSeparator(base: string): number | null {
  if (refGrammar(base) === null) return null;
  const at = base.lastIndexOf("@");
  return at > (base.startsWith(OCI_SCHEME) ? OCI_SCHEME.length : 0) ? at : null;
}
