// Shared, build-time resolution of package version pins in documentation.
//
// Docs reference packages with a literal `<version>` marker instead of a real
// version: `oci://ghcr.io/telorun/console@<version>`, `@telorun/run@<version>`.
// At build time we substitute the marker with the version from LOCAL source of
// truth — never the network — so the rendered site and the llms-txt outputs
// always match the repo's working state:
//
//   - oci://ghcr.io/telorun/<name>  → metadata.version in modules/<name>/telo.yaml
//   - @telorun/<name>               → version in that package's package.json
//
// The OCI repository name is the module's DIRECTORY name, which is what
// `publish-packages.mjs` pushes to — not `metadata.name`, which may differ.
//
// A ref to a package that doesn't resolve locally is a hard build error — a
// typo or an illustrative ref that was wrongly tokenized. Illustrative refs
// (e.g. `oci://ghcr.io/acme/foo@1.0.0`) keep a real literal version and are
// left untouched.

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// `oci://ghcr.io/telorun/console`, `@telorun/run` (or inside a purl:
// `pkg:npm/@telorun/run@<version>#…`).
const REF =
  /(oci:\/\/ghcr\.io\/telorun\/[a-z0-9][a-z0-9-]*|@telorun\/[a-z0-9][a-z0-9-]*)@<version>/g;

// The same grammar with a REAL version where the marker belongs — what an author
// writes when they forget the marker. Checked, never substituted: see
// findLiteralVersionRefs.
const LITERAL_REF =
  /(oci:\/\/ghcr\.io\/telorun\/[a-z0-9][a-z0-9-]*|@telorun\/[a-z0-9][a-z0-9-]*)@(\d+\.\d+\.\d+)/g;

// A ref carrying a `#sha256-` digest keeps its literal version, by RULE rather than
// by listing: the digest cannot be derived locally, so moving the version beside it
// would print a real version with a digest that does not match — a pin that fails
// terminally for whoever copies it. Written as a rule because the listed form keyed
// on the exact version, so legitimately re-pinning such a doc broke the check on the
// very line that had just been corrected.
const DIGEST_SUFFIX = "#sha256-";

// Literal versions that are deliberate, keyed by the ref as written. Each is a case
// where substituting the current version would make the passage WRONG, not merely
// stale — so the marker is the wrong tool and the check must stay quiet.
const LITERAL_EXCEPTIONS = [
  {
    file: "docs/extend/declaring-runtime-requirements.md",
    ref: "@telorun/cli@0.80.0",
    reason:
      "Illustrates running an OLDER CLI at a declared range's low edge. Pinning it to " +
      "the current version inverts what the sentence demonstrates.",
  },
];

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
      if (metadata?.version) {
        map.set(`oci://ghcr.io/telorun/${entry.name}`, String(metadata.version));
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

/**
 * Every hardcoded version in `content` that the marker COULD have carried — a ref
 * naming something this repo publishes, written with a version instead of
 * `<version>`. Refs that resolve nowhere locally (`ghcr.io/acme/foo`, the
 * externally-published `aws/lambda`) are not reported: the substituter cannot fix
 * them either, so a literal there is the only honest spelling.
 *
 * Returns `{ ref, version, line }` per hit; `file` is the repo-relative path used
 * to match LITERAL_EXCEPTIONS.
 */
function findLiteralVersionRefs(content, file, map = buildVersionMap()) {
  const hits = [];
  for (const match of content.matchAll(LITERAL_REF)) {
    const [full, ref, version] = match;
    if (!map.has(ref)) continue;
    if (content.startsWith(DIGEST_SUFFIX, match.index + full.length)) continue;
    if (LITERAL_EXCEPTIONS.some((e) => e.file === file && e.ref === full)) continue;
    hits.push({
      ref,
      version,
      current: map.get(ref),
      line: content.slice(0, match.index).split("\n").length,
    });
  }
  return hits;
}

module.exports = {
  buildVersionMap,
  substituteVersions,
  findLiteralVersionRefs,
  LITERAL_EXCEPTIONS,
};
