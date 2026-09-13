import * as path from "path";

import { isPayloadLink, type LayerEntry, type PayloadLink } from "./files-integrity.js";

/** An entry of one layer breaking the layer's entry rules, and why. `target` is
 *  set when the entry is a link and the violation is about where it points. */
export interface LayerViolation {
  path: string;
  target?: string;
  reason: string;
}

/**
 * Every entry of one layer that breaks the rules extraction relies on to stay
 * inside the module directory:
 *
 * - an entry's path stays within the module directory, and is unique in the layer;
 * - no entry's path runs through another entry's path as a directory — without
 *   this a link entry could stand where a later entry needs a directory, and the
 *   later entry would be written wherever the link points;
 * - the link rule: a link's target, resolved against the link's own directory,
 *   stays within the module directory and is the path of another entry of the
 *   layer, a link to a link being followed until it reaches a regular file. The
 *   path rule says nothing about where a link points, and a target in another
 *   layer dangles whenever that layer is not materialized.
 *
 * `elsewhere` is the module's paths outside this layer, when the caller knows
 * them (publish does, extraction does not), so a target in another layer is told
 * apart from one that names nothing.
 */
export function findLayerViolations(
  files: readonly LayerEntry[],
  elsewhere?: ReadonlySet<string>,
): LayerViolation[] {
  const violations: LayerViolation[] = [];
  const byPath = new Map<string, LayerEntry>();
  for (const file of files) {
    const key = entryPath(file.name);
    const existing = key === undefined ? undefined : byPath.get(key);
    if (key === undefined) {
      violations.push({ path: file.name, reason: "escapes the module directory" });
    } else if (existing) {
      violations.push({ path: file.name, reason: `is the same path as '${existing.name}'` });
    } else {
      byPath.set(key, file);
    }
  }
  for (const [key, file] of byPath) {
    const segments = key.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = byPath.get(segments.slice(0, depth).join("/"));
      if (!parent) continue;
      violations.push({
        path: file.name,
        reason: `runs through '${parent.name}', another entry of the layer, as a directory`,
      });
      break;
    }
  }
  for (const file of byPath.values()) {
    if (!isPayloadLink(file)) continue;
    const reason = linkProblem(file, byPath, elsewhere);
    if (reason) violations.push({ path: file.name, target: file.link, reason });
  }
  return violations;
}

/** An entry's normalized module-relative path, or `undefined` when it is
 *  absolute or climbs out of the module directory. */
function entryPath(name: string): string | undefined {
  if (path.posix.isAbsolute(name)) return undefined;
  const normalized = path.posix.normalize(name).replace(/\/+$/, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

function linkProblem(
  start: PayloadLink,
  byPath: ReadonlyMap<string, LayerEntry>,
  elsewhere: ReadonlySet<string> | undefined,
): string | undefined {
  const visited = new Set<string>([start.name]);
  let current = start;
  for (;;) {
    const via = current === start ? "" : `through '${current.name}', `;
    if (current.link === "") return `${via}has no target`;
    if (path.posix.isAbsolute(current.link)) {
      return `${via}is absolute, so it escapes the module directory`;
    }
    const target = resolveLinkTarget(current);
    if (target === undefined) return `${via}escapes the module directory`;
    const entry = byPath.get(target);
    if (!entry) {
      return elsewhere?.has(target)
        ? `${via}names '${target}', which ships in another layer`
        : `${via}names '${target}', which no file of the layer has (the link dangles)`;
    }
    if (!isPayloadLink(entry)) return undefined;
    if (visited.has(entry.name)) return `forms a cycle through '${current.name}'`;
    visited.add(entry.name);
    current = entry;
  }
}

/** The module-relative path a relative link names, or `undefined` when it climbs
 *  out of the module directory. */
function resolveLinkTarget(link: PayloadLink): string | undefined {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(link.name), link.link));
  if (resolved === ".." || resolved.startsWith("../")) return undefined;
  return resolved;
}

/** One line per violation, for a refusal message. */
export function describeLayerViolations(violations: readonly LayerViolation[]): string {
  return violations
    .map((v) =>
      v.target === undefined
        ? `  '${v.path}': ${v.reason}`
        : `  '${v.path}' → '${v.target}': ${v.reason}`,
    )
    .join("\n");
}
