// Dependency ordering for module manifest pushes, shared by the release publish
// (`publish-packages.mjs`, the changed set) and the OCI backfill
// (`publish-oci-backfill.mjs`, the whole tree).
//
// Both need the same guarantee: `telo publish` canonicalizes a relative
// `imports:` source against the destination and then HARD-FAILS if the derived
// ref does not already resolve there, so a sibling must be pushed before its
// dependents. Ordering is the only thing that makes a multi-module push
// succeed.

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/** Sibling module names an `imports:` entry of the first YAML document points at
 *  with a relative source (`../<name>`, bare or object `source:` form). */
export function relativeImportDeps(yamlPath) {
  const content = readFileSync(yamlPath, "utf8");
  const docEnd = content.search(/^---\s*$/m);
  const firstDoc = docEnd === -1 ? content : content.slice(0, docEnd);
  const block = firstDoc.match(/^imports:\s*\n((?:(?:[ \t]+.*)?\n)+)/m);
  if (!block) return [];
  const deps = new Set();
  for (const line of block[1].split("\n")) {
    const source = line.match(/:[ \t]*["']?(\.\.?\/[^"'#\s]+)/);
    if (source) deps.add(basename(source[1].replace(/\/telo\.yaml$/, "").replace(/\/+$/, "")));
  }
  return [...deps];
}

/** Depth-first topological order over the batch's relative imports, so a
 *  dependency is pushed before its dependents. Ties and cycle members keep their
 *  incoming (alphabetical) order. */
export function orderByDependencies(paths) {
  const byName = new Map(paths.map((p) => [basename(dirname(p)), p]));
  const ordered = [];
  const state = new Map();
  const visit = (name) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      console.warn(`  warning: import cycle through module '${name}' — publish order may be wrong`);
      return;
    }
    state.set(name, "visiting");
    for (const dep of relativeImportDeps(byName.get(name))) {
      if (byName.has(dep)) visit(dep);
    }
    state.set(name, "done");
    ordered.push(byName.get(name));
  };
  for (const name of byName.keys()) visit(name);
  return ordered;
}
