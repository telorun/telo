import { splitIntegrity } from "@telorun/analyzer";

export const OCI_SCHEME = "oci://";

/** A parsed `oci://host/repo@reference` module ref.
 *
 *  - `host` — the registry host (`ghcr.io`, `123.dkr.ecr.us-east-1.amazonaws.com`).
 *  - `repo` — the repository path (`aws/telo-s3`), possibly multi-segment.
 *  - `reference` — a tag (`1.2.0`) or a digest (`sha256:...`); the OCI address.
 *  - `integrity` — Telo's inline `sha256-<base64url>` hash when the ref is pinned
 *    (authoritative across transports; the OCI digest is only corroborating). */
export interface ParsedOciRef {
  host: string;
  repo: string;
  reference: string;
  integrity?: string;
}

/** True when `ref` uses the `oci://` scheme (integrity fragment tolerated). */
export function isOciRef(ref: string): boolean {
  return splitIntegrity(ref).base.startsWith(OCI_SCHEME);
}

/** Parse `oci://host/repo@reference[#sha256-...]`. Throws on a malformed ref.
 *  A `reference` may be a tag or a `sha256:` digest; when absent (`@` omitted)
 *  it defaults to `latest`, matching OCI tooling. */
export function parseOciRef(ref: string): ParsedOciRef {
  const { base, integrity } = splitIntegrity(ref);
  if (!base.startsWith(OCI_SCHEME)) {
    throw new Error(`Invalid OCI reference '${ref}', expected oci://host/repo@reference`);
  }
  const rest = base.slice(OCI_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    throw new Error(`Invalid OCI reference '${ref}', missing repository path after host`);
  }
  const host = rest.slice(0, slash);
  let repoAndRef = rest.slice(slash + 1);

  let reference = "latest";
  const at = repoAndRef.lastIndexOf("@");
  // A digest reference is `repo@sha256:...` — the `@` before `sha256:` is the
  // separator, not part of the repo. A tag reference has no `@`.
  if (at > 0) {
    reference = repoAndRef.slice(at + 1);
    repoAndRef = repoAndRef.slice(0, at);
  }
  const repo = repoAndRef;
  if (!host || !repo || !reference) {
    throw new Error(`Invalid OCI reference '${ref}', expected oci://host/repo@reference`);
  }
  return { host, repo, reference, integrity };
}
