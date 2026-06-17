// Shared, build-time resolution of package version pins in documentation.
//
// Docs reference packages with a literal `<version>` marker instead of a real
// version: `std/console@<version>`, `@telorun/run@<version>`. At build time we
// substitute the marker with the version from LOCAL source of truth — never
// the network — so the rendered site and the llms-txt outputs always match the
// repo's working state:
//
//   - std/<name>       → metadata.version in modules/<name>/telo.yaml
//   - @telorun/<name>  → version in that package's package.json
//
// A ref to a package that doesn't resolve locally is a hard build error — a
// typo or an illustrative ref that was wrongly tokenized. Illustrative refs
// (e.g. `std/foo@1.0.0`) keep a real literal version and are left untouched.

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// `std/console`, `@telorun/run` (or inside a purl: `pkg:npm/@telorun/run@<version>#…`).
const REF = /(std\/[a-z0-9][a-z0-9-]*|@telorun\/[a-z0-9][a-z0-9-]*)@<version>/g;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".telo",
  ".pnpm",
  "tmp",
]);

let cached = null;

function buildVersionMap() {
  if (cached) return cached;
  const map = new Map();
  collectModuleVersions(map);
  collectPackageVersions(REPO_ROOT, map);
  cached = map;
  return map;
}

function collectModuleVersions(map) {
  const modulesDir = path.join(REPO_ROOT, "modules");
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(modulesDir, entry.name, "telo.yaml");
    if (!fs.existsSync(manifest)) continue;
    for (const doc of YAML.parseAllDocuments(fs.readFileSync(manifest, "utf8"))) {
      const metadata = doc.toJS()?.metadata;
      if (metadata?.name && metadata?.version) {
        map.set(`std/${metadata.name}`, String(metadata.version));
        break;
      }
    }
  }
}

function collectPackageVersions(dir, map) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectPackageVersions(full, map);
    } else if (entry.isFile() && entry.name === "package.json") {
      const pkg = JSON.parse(fs.readFileSync(full, "utf8"));
      if (typeof pkg.name === "string" && pkg.name.startsWith("@telorun/") && pkg.version) {
        map.set(pkg.name, String(pkg.version));
      }
    }
  }
}

function substituteVersions(content, map = buildVersionMap(), source) {
  return content.replace(REF, (full, ref, offset) => {
    const version = map.get(ref);
    if (!version) {
      const line = content.slice(0, offset).split("\n").length;
      const at = source ? `${source}:${line}` : `${ref}@<version>`;
      throw new Error(
        `No local version found for "${ref}" (referenced at ${at}). ` +
          `Tokenize only packages that exist in modules/ or as a published @telorun/* package; ` +
          `illustrative refs should keep a literal version.`,
      );
    }
    return `${ref}@${version}`;
  });
}

module.exports = { buildVersionMap, substituteVersions };
