/**
 * THIRD_PARTY_NOTICES: the MIT license text of every MIT package the host
 * runner's bundle holds. The host runner is under a restricted license and
 * redistributes MIT code (the CLI, the kernel, the analyzer and the rest of its
 * closure), and MIT requires the notice to travel with it.
 *
 * The package list is read from the bundle's esbuild metafile — what is
 * actually inside the executable, not what a manifest declares. A package's
 * license is its own `package.json` `license` field and its text is the
 * `LICENSE` file of its directory (a workspace package may keep it one level up,
 * beside its unit, but never at the repository root, which holds another
 * license). An MIT package with no license text fails the build: a silent skip
 * would ship the code without the notice that is the condition of shipping it.
 *
 *   node scripts/third-party-notices.mjs --out <file>
 *   node scripts/third-party-notices.mjs --metafile <esbuild metafile> --out <file>
 *
 * With no `--metafile` it bundles the runner's entry with the CLI's standalone
 * recipe (`--bundle-only`) to get one.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = path.resolve(HERE, "..");
export const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");

const LICENSE_FILE = /^(licen[sc]e|copying)(\.(md|txt|markdown))?$/i;
const MIT = /(^|[\s(])MIT([\s)]|$)/;

/** The SPDX text a `package.json` declares, whichever of its three spellings. */
function declaredLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l?.type ?? "").join(" OR ");
  return "";
}

function nearestPackage(file, cache) {
  let dir = path.dirname(file);
  for (;;) {
    if (cache.has(dir)) return cache.get(dir);
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (typeof pkg.name === "string") {
        const found = { dir, pkg };
        cache.set(dir, found);
        return found;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** The license a package states in its README, for one that ships no license file:
 *  the standard MIT paragraph and the copyright line directly above it. */
const README_LICENSE = /(?:Copyright[^\n]*\n\s*\n?)?Permission is hereby granted[\s\S]*?DEALINGS IN\s+THE\s+SOFTWARE\./;

/**
 * Where a package's license text is, in order: its `LICENSE` file, a workspace
 * package's unit directory, the license its README reproduces, and last the
 * reviewed `supplements` entry (`scripts/notice-supplements.json`: the copyright
 * line of a package that declares MIT and carries no text at all, rendered on the
 * standard MIT text). Nothing else is guessed.
 */
function licenseText(dir, workspaceRoot, name, supplements) {
  const inDir = (d) => {
    const entry = fs.readdirSync(d).find((candidate) => LICENSE_FILE.test(candidate));
    return entry ? fs.readFileSync(path.join(d, entry), "utf8").trim() : undefined;
  };
  const own = inDir(dir);
  if (own !== undefined) return own;
  // A workspace package keeps its unit's license one level up (`sdk/LICENSE` for
  // `sdk/nodejs`); an installed one has no such place.
  if (!dir.includes(`${path.sep}node_modules${path.sep}`)) {
    const parent = path.dirname(dir);
    if (parent !== workspaceRoot && path.dirname(parent) !== parent) {
      const up = inDir(parent);
      if (up !== undefined) return up;
    }
  }
  const readme = fs.readdirSync(dir).find((candidate) => /^readme(\.(md|markdown|txt))?$/i.test(candidate));
  if (readme) {
    const found = README_LICENSE.exec(fs.readFileSync(path.join(dir, readme), "utf8"));
    if (found) return found[0].trim();
  }
  const copyright = supplements[name];
  return copyright === undefined ? undefined : `${copyright}\n\n${MIT_TEXT}`;
}

/**
 * The notices for every MIT package among the metafile's inputs.
 * `metafile` paths are relative to `root`. Throws when an MIT package has no
 * license text, naming every one.
 */
export function noticesFromMetafile(metafile, root, workspaceRoot = root, supplements = {}) {
  const cache = new Map();
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    // Namespaced inputs (`<define:…>`, `(disabled):…`) are not files of a package.
    if (input.startsWith("<")) continue;
    const file = path.resolve(root, input.replace(/^\(disabled\):/, ""));
    const owner = nearestPackage(file, cache);
    if (!owner) throw new Error(`bundle input ${input} belongs to no package, so its license cannot be read`);
    if (MIT.test(declaredLicense(owner.pkg))) packages.set(owner.dir, owner);
  }
  // One notice per name and version: pnpm may bundle two copies of one release.
  const copies = new Map();
  for (const { dir, pkg } of packages.values()) {
    const key = `${pkg.name}@${pkg.version}`;
    copies.set(key, [...(copies.get(key) ?? []), { dir, pkg }]);
  }
  const missing = [];
  const entries = [];
  for (const group of copies.values()) {
    const { pkg } = group[0];
    const text = group.map(({ dir }) => licenseText(dir, workspaceRoot, pkg.name, supplements)).find((found) => found !== undefined);
    if (text === undefined) missing.push(`${pkg.name}@${pkg.version} (${group[0].dir})`);
    else entries.push({ name: pkg.name, version: pkg.version, text });
  }
  if (missing.length > 0) {
    throw new Error(
      `these packages declare the MIT license but hold no LICENSE file, so their notices cannot be written:\n` +
        missing.map((m) => `  ${m}`).join("\n"),
    );
  }
  entries.sort((a, b) => (a.name === b.name ? String(a.version).localeCompare(String(b.version)) : a.name.localeCompare(b.name)));

  const header = [
    "THIRD-PARTY NOTICES",
    "",
    "The Telo host runner bundles the MIT-licensed packages listed below.",
    "Each is distributed under its own license text, reproduced in full.",
  ].join("\n");
  const body = entries.map((e) => `${"-".repeat(72)}\n${e.name}@${e.version}\n\n${e.text}\n`);
  return `${[header, ...body].join("\n\n")}\n`;
}

/** The reviewed copyright lines for packages that declare MIT and ship no text. */
export function readSupplements() {
  return JSON.parse(fs.readFileSync(path.join(HERE, "notice-supplements.json"), "utf8"));
}

function option(argv, flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

/** The metafile of the runner's bundle, from the CLI's standalone recipe. */
export function bundleMetafile(metafilePath, entry = path.join(PACKAGE_DIR, "dist", "entry.js")) {
  execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "cli", "nodejs", "scripts", "build-standalone.mjs"),
      "--bundle-only",
      "--entry",
      entry,
      "--name",
      "telo-host-runner",
      "--metafile",
      metafilePath,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const out = option(argv, "--out");
  if (!out) throw new Error("usage: third-party-notices.mjs [--metafile <file>] --out <file>");
  let metafilePath = option(argv, "--metafile");
  let scratch;
  if (!metafilePath) {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telo-host-runner-notices-"));
    metafilePath = path.join(scratch, "meta.json");
    bundleMetafile(metafilePath);
  }
  try {
    const metafile = JSON.parse(fs.readFileSync(metafilePath, "utf8"));
    fs.writeFileSync(path.resolve(out), noticesFromMetafile(metafile, REPO_ROOT, REPO_ROOT, readSupplements()));
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}
