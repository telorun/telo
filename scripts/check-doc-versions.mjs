#!/usr/bin/env node
// Fails when a documentation page hardcodes a version for a ref this repo
// publishes, instead of writing the `<version>` marker the site substitutes at
// build time.
//
// The marker only helps where it is used, and nothing stopped an author from
// writing a real version beside it. That is how the docs came to name
// `sql@1.2.0` — a version line that never existed — and a `console` five minors
// behind, both of which read as current to someone copying them.
//
// SCOPE IS DERIVED FROM `pages/sidebars.ts`, the same list the site renders. It used
// to be a hand-written set of doc roots, which was a SECOND scope beside the site's
// — and it drifted in the one direction that matters: it covered eight files the
// site does not render (seven `kernel/specs/*` and the root README), where the
// remedy this check prints is actively wrong. Those pages are read on GitHub, where
// nothing substitutes, so `<version>` would render as the literal string
// `<version>`. Checking exactly what the site renders is the only scope for which
// "write the marker" is true advice.
//
// Module READMEs and `modules/*/docs` are outside it for the same reason and always
// were: the hub serves that markdown raw from the published artifact.
//
// Usage: node scripts/check-doc-versions.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { buildVersionMap, findLiteralVersionRefs } = createRequire(import.meta.url)(
  join(ROOT, "pages", "lib", "version-map.js"),
);

// Doc ids from the sidebar, as repo-relative markdown paths. The site resolves them
// the same way: `docInclude` maps each id to `<id>.md`, and the docs plugin roots at
// the repo. Read with a pattern rather than by importing the module because this is
// a plain Node script and the sidebar is TypeScript; the file is uniform data, and a
// shape change is caught by the sanity check below rather than silently narrowing
// the scope to nothing.
function sidebarDocFiles() {
  const source = readFileSync(join(ROOT, "pages", "sidebars.ts"), "utf8");
  const ids = [...source.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);
  if (ids.length < 40) {
    console.error(
      `::error file=pages/sidebars.ts::Read only ${ids.length} doc ids from the sidebar; the ` +
        `file's shape changed and the documentation version check would silently cover ` +
        `almost nothing. Update sidebarDocFiles in scripts/check-doc-versions.mjs.`,
    );
    process.exit(1);
  }
  return ids.map((id) => join(ROOT, `${id}.md`));
}

const map = buildVersionMap();
const failures = [];

for (const file of sidebarDocFiles()) {
  if (!existsSync(file)) continue; // A sidebar entry pointing nowhere is the site's to report.
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  for (const hit of findLiteralVersionRefs(readFileSync(file, "utf8"), rel, map)) {
    failures.push({ rel, ...hit });
  }
}

if (failures.length === 0) {
  console.log("Doc version pins: no hardcoded versions.");
  process.exit(0);
}

console.error(
  `${failures.length} hardcoded version${failures.length === 1 ? "" : "s"} in documentation:\n`,
);
for (const f of failures) {
  console.error(
    `  ${f.rel}:${f.line}  ${f.ref}@${f.version}  (currently ${f.current})`,
  );
}
console.error(
  `\nWrite \`${"<version>"}\` instead of the version — the site substitutes it at build time ` +
    `from this repo's own manifests and package.json files.\n` +
    `A literal that is deliberate belongs in LITERAL_EXCEPTIONS in pages/lib/version-map.js, ` +
    `with the reason substituting it would be wrong.`,
);
process.exit(1);
