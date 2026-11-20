/** The Node checker for the `vcs-url` Telo format: a git repository's location in
 *  the SPDX / purl VCS notation, `git+https://<host>[:<port>]/<path>`, with no
 *  revision. Browser-safe. */

import type { TeloFormatChecker, TeloFormatFailure } from "./telo-format.js";

const PREFIX = "git+https://";
const HOST_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** A host label: alphanumerics and inner hyphens, never ending in one. */
function isHostLabel(label: string): boolean {
  return HOST_LABEL.test(label) && !label.endsWith("-");
}

function segmentFailure(segment: string, base: number): TeloFormatFailure | undefined {
  if (segment === "" || segment === "." || segment === "..") {
    return { reason: "a path segment must be a name, not empty, '.' or '..'", offset: base };
  }
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (ch === "%") {
      if (!/^[0-9A-Fa-f]{2}$/.test(segment.slice(i + 1, i + 3))) {
        return { reason: "a '%' must be followed by two hexadecimal digits", offset: base + i };
      }
    } else if (/[\s\x00-\x1f\x7f]/.test(ch)) {
      return { reason: "whitespace and control characters must be percent-encoded", offset: base + i };
    }
  }
  return undefined;
}

function checkVcsUrl(value: string): TeloFormatFailure | undefined {
  if (!value.startsWith(PREFIX)) {
    if (/^https:\/\//i.test(value)) {
      return { reason: `it names no version control tool: write git+${value}`, offset: 0 };
    }
    return {
      reason: "a VCS location starts with git+https://, as in git+https://github.com/acme/engine",
      offset: 0,
    };
  }
  for (const [mark, reason] of [
    ["@", "a VCS location carries no user name, password or revision ('@'); the revision is written in vcs.revision"],
    ["?", "a VCS location carries no query ('?')"],
    ["#", "a VCS location carries no fragment ('#'); the revision is written in vcs.revision"],
  ] as const) {
    const at = value.indexOf(mark);
    if (at !== -1) return { reason, offset: at };
  }
  const rest = value.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  if (authority === "") return { reason: "it names no host: write git+https://<host>/<path>", offset: PREFIX.length };
  const colon = authority.indexOf(":");
  const host = colon === -1 ? authority : authority.slice(0, colon);
  if (host === "" || !host.split(".").every((label) => isHostLabel(label))) {
    return {
      reason:
        `the host '${host}' must be letters, digits, '-' and '.', each dot-separated label ` +
        `starting and ending with a letter or digit`,
      offset: PREFIX.length,
    };
  }
  if (colon !== -1) {
    const port = authority.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      return { reason: `the port '${port}' must be a number from 1 to 65535`, offset: PREFIX.length + colon + 1 };
    }
  }
  if (slash === -1 || slash === rest.length - 1) {
    return { reason: "it names no repository path: write git+https://<host>/<path>", offset: value.length };
  }
  let offset = PREFIX.length + slash + 1;
  for (const segment of rest.slice(slash + 1).split("/")) {
    const bad = segmentFailure(segment, offset);
    if (bad) return bad;
    offset += segment.length + 1;
  }
  return undefined;
}

export const vcsUrlChecker: TeloFormatChecker = { check: checkVcsUrl };
