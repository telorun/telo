import { splitIntegrity } from "./integrity.js";

/** A parsed registry module reference. `modulePath` is `namespace/name`,
 *  `version` has any leading `v` stripped, and `integrity` carries the inline
 *  `sha256-<base64url>` hash when the ref was pinned. */
export interface ParsedModuleRef {
  modulePath: string;
  version: string;
  integrity?: string;
}

/** True when `url` has the bare registry-ref shape `namespace/name@version`
 *  (no scheme, no leading `/` or `.`, contains both `@` and `/`). The integrity
 *  fragment, if any, does not affect the classification. */
export function isRegistryRef(url: string): boolean {
  const { base } = splitIntegrity(url);
  return (
    !base.startsWith("http://") &&
    !base.startsWith("https://") &&
    !base.startsWith("/") &&
    !base.startsWith(".") &&
    !base.startsWith("file://") &&
    !base.startsWith("memory://") &&
    base.includes("@") &&
    base.includes("/")
  );
}

/** Canonical parser for `namespace/name@version[#sha256-...]` refs. The single
 *  source of truth shared by the registry source, the kernel manifest cache,
 *  and the CLI (install / upgrade / bundle). Throws on a malformed ref. */
export function parseModuleRef(ref: string): ParsedModuleRef {
  const { base, integrity } = splitIntegrity(ref);
  const atIdx = base.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === base.length - 1) {
    throw new Error(`Invalid module reference '${ref}', expected namespace/name@version`);
  }
  const modulePath = base.slice(0, atIdx);
  if (!modulePath.includes("/")) {
    throw new Error(`Invalid module reference '${ref}', expected namespace/name@version`);
  }
  const rawVersion = base.slice(atIdx + 1);
  const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion;
  if (!version) {
    throw new Error(`Invalid module reference '${ref}', expected namespace/name@version`);
  }
  return { modulePath, version, integrity };
}
