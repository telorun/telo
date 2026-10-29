import { splitIntegrity } from "./integrity.js";

export const OCI_SCHEME = "oci://";

/** A parsed `oci://host/repo@reference` module ref.
 *
 *  - `host` — the registry host (`ghcr.io`, `123.dkr.ecr.us-east-1.amazonaws.com`).
 *  - `repo` — the repository path (`aws/telo-s3`), possibly multi-segment.
 *  - `reference` — a tag (`1.2.0`) or a digest (`sha256:...`); the OCI address.
 *  - `path` — present only on a NESTED module's identity,
 *    `oci://host/repo@sha256:<hex>/<path>`: the module's path inside the
 *    artifact `reference` names, `/`-separated. A directory means its
 *    `telo.yaml`, otherwise the file. The runtime builds this form while
 *    resolving a relative import inside an artifact; authors never write it.
 *  - `integrity` — Telo's inline `sha256-<base64url>` hash when the ref is pinned
 *    (authoritative across transports; the OCI digest is only corroborating). */
export interface ParsedOciRef {
  host: string;
  repo: string;
  reference: string;
  path?: string;
  integrity?: string;
}

/** A digest reference followed by a path. A digest cannot contain `/`, so the
 *  text after it can only be a path. */
const DIGEST_WITH_PATH = /^(sha256:[0-9a-f]{64})\/(.+)$/;

/** True for a tag spelled like a digest's cache folder (`sha256-<64 hex>`). Such
 *  a tag would share a directory with the digest, so a ref naming one is refused. */
export function isDigestSpelledTag(reference: string): boolean {
  return /^sha256-[0-9a-f]{64}$/.test(reference);
}

/** True when `ref` uses the `oci://` scheme (integrity fragment tolerated). */
export function isOciRef(ref: string): boolean {
  return splitIntegrity(ref).base.startsWith(OCI_SCHEME);
}

/** Parse `oci://host/repo@reference[/path][#sha256-...]`. Throws on a malformed
 *  ref. A `reference` may be a tag or a `sha256:` digest; when absent (`@`
 *  omitted) it defaults to `latest`, matching OCI tooling. A path follows a
 *  digest reference only. */
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
  // The first `@` separates: a repository never contains one, while a nested
  // module's path after the digest may.
  const at = repoAndRef.indexOf("@");
  if (at > 0) {
    reference = repoAndRef.slice(at + 1);
    repoAndRef = repoAndRef.slice(0, at);
  }
  const repo = repoAndRef;
  if (!host || !repo || !reference) {
    throw new Error(`Invalid OCI reference '${ref}', expected oci://host/repo@reference`);
  }
  if (isDigestSpelledTag(reference)) {
    throw new Error(
      `Invalid OCI reference '${ref}': a tag spelled like a digest is refused; digests are written @sha256:<hex>`,
    );
  }
  const nested = DIGEST_WITH_PATH.exec(reference);
  if (!nested) return { host, repo, reference, ...(integrity ? { integrity } : {}) };
  const path = nested[2];
  if (path.split("/").some((s) => s === "" || s === "." || s === ".." || s.includes("\\"))) {
    throw new Error(
      `Invalid OCI reference '${ref}': the path after the digest must name a module inside ` +
        `the artifact, '/'-separated with no empty, '.' or '..' segment`,
    );
  }
  return { host, repo, reference: nested[1], path, ...(integrity ? { integrity } : {}) };
}

/** The identity of the module at `path` inside the artifact whose OCI manifest
 *  digest is `digest`: `oci://<host>/<repo>@<digest>/<path>`. Built from the
 *  digest, never a tag, so a cached nested module cannot go stale when a tag
 *  moves. */
export function nestedOciRef(
  artifact: { host: string; repo: string; digest: string },
  path: string,
): string {
  return `${OCI_SCHEME}${artifact.host}/${artifact.repo}@${artifact.digest}/${path}`;
}

/** `relative` resolved against `dir`, a directory inside an artifact (`""` for
 *  its root), as a relative import resolves on disk — `/`-separated, `.` and
 *  `..` applied. `null` when the result leaves the artifact root, or when
 *  `relative` is absolute. */
export function artifactPath(dir: string, relative: string): string | null {
  if (relative.startsWith("/") || relative.includes("\\")) return null;
  const out: string[] = dir === "" ? [] : dir.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}
