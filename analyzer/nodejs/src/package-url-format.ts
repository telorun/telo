/** The Node checker for the `package-url` Telo format: a Package URL (purl) that
 *  names a package and no version. Browser-safe. */

import type { TeloFormatChecker, TeloFormatFailure } from "./telo-format.js";

const TYPE = /^[a-z][a-z0-9.+-]*$/;
const QUALIFIER_KEY = /^[a-z][a-z0-9._-]*$/;
/** The qualifier a bill of materials writes from a declared `vcs:`, never written by hand. */
const VCS_QUALIFIER = "vcs_url";

/** Why one percent-encoded component is malformed, or undefined. */
function componentFailure(text: string, base: number): TeloFormatFailure | undefined {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "%") {
      if (!/^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
        return { reason: "a '%' must be followed by two hexadecimal digits", offset: base + i };
      }
    } else if (/[\s\x00-\x1f\x7f]/.test(ch)) {
      return { reason: "whitespace and control characters must be percent-encoded", offset: base + i };
    }
  }
  return undefined;
}

function checkPackageUrl(value: string): TeloFormatFailure | undefined {
  if (!value.startsWith("pkg:")) {
    return { reason: "a package URL starts with the scheme pkg:, as in pkg:npm/left-pad", offset: 0 };
  }
  const hash = value.indexOf("#");
  const beforeHash = hash === -1 ? value.length : hash;
  const query = value.slice(0, beforeHash).indexOf("?");
  const pathEnd = query === -1 ? beforeHash : query;
  const path = value.slice(4, pathEnd);

  const slash = path.indexOf("/");
  if (slash === -1) {
    return { reason: "it has no name: write pkg:<type>/<name>", offset: value.length };
  }
  const type = path.slice(0, slash);
  if (!TYPE.test(type)) {
    return {
      reason: `the type '${type}' must be lower-case letters, digits, '.', '+' or '-', and not start with a digit`,
      offset: 4,
    };
  }

  const at = path.indexOf("@", slash);
  if (at !== -1) {
    const after = path.slice(at + 1);
    if (after.includes("/")) {
      return {
        reason: "an '@' inside a namespace or name is written %40, as in pkg:npm/%40napi-rs/canvas",
        offset: 4 + at,
      };
    }
    return {
      reason:
        `it names a version (@${after}). A source's version is its \`version:\`; write ` +
        `${value.slice(0, 4 + at)}`,
      offset: 4 + at,
    };
  }

  let offset = 4 + slash + 1;
  const segments = path.slice(slash + 1).split("/");
  for (const segment of segments) {
    if (segment === "") {
      return {
        reason: segments.length === 1 ? "it has no name: write pkg:<type>/<name>" : "a namespace or name segment is empty",
        offset,
      };
    }
    const bad = componentFailure(segment, offset);
    if (bad) return bad;
    offset += segment.length + 1;
  }

  if (query !== -1) {
    const text = value.slice(query + 1, beforeHash);
    if (text === "") return { reason: "the qualifiers after '?' are empty", offset: query };
    const seen = new Set<string>();
    const pairs = text.split("&");
    let at = query + 1;
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      const key = eq === -1 ? pair : pair.slice(0, eq);
      if (eq === -1 || !QUALIFIER_KEY.test(key)) {
        return {
          reason: `the qualifier '${pair}' must be key=value with a lower-case key of letters, digits, '.', '-' or '_'`,
          offset: at,
        };
      }
      if (key === VCS_QUALIFIER) {
        const rest = pairs.filter((other) => other.split("=", 1)[0] !== VCS_QUALIFIER);
        const written = `${value.slice(0, query)}${rest.length > 0 ? `?${rest.join("&")}` : ""}${value.slice(beforeHash)}`;
        return {
          reason:
            "it carries a vcs_url qualifier. The repository and commit are declared beside the package URL as " +
            `\`vcs: { url, revision }\`; write ${written}`,
          offset: at,
        };
      }
      if (eq === pair.length - 1) return { reason: `the qualifier '${key}' has no value`, offset: at };
      if (seen.has(key)) return { reason: `the qualifier '${key}' is given twice`, offset: at };
      seen.add(key);
      const bad = componentFailure(pair.slice(eq + 1), at + eq + 1);
      if (bad) return bad;
      at += pair.length + 1;
    }
  }

  if (hash !== -1) {
    const text = value.slice(hash + 1);
    if (text === "") return { reason: "the subpath after '#' is empty", offset: hash };
    let at = hash + 1;
    for (const segment of text.split("/")) {
      if (segment === "" || segment === "." || segment === "..") {
        return { reason: "a subpath segment must be a name, not empty, '.' or '..'", offset: at };
      }
      const bad = componentFailure(segment, at);
      if (bad) return bad;
      at += segment.length + 1;
    }
  }
  return undefined;
}

export const packageUrlChecker: TeloFormatChecker = { check: checkPackageUrl };
