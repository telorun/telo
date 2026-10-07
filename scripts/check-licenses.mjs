#!/usr/bin/env node
/**
 * The license boundary check.
 *
 * The repository carries two licenses: the Sustainable Use text at the root, and
 * MIT in the directories listed below. One rule keeps them separable — nothing
 * MIT depends on anything that is not — and a declaration nothing checks drifts
 * the first time a package gains a convenient import. Fails when:
 *
 * - an MIT directory has no `LICENSE`, or a package or crate beneath one
 *   declares anything else;
 * - an MIT package names a workspace package that is not MIT in its
 *   dependencies, dev dependencies, peer dependencies or `teloInlines`;
 * - an MIT crate has a path dependency on a crate that is not MIT, or any crate
 *   declares no license at all;
 * - a module root has no `LICENSE`, or its module doc does not declare
 *   `license: MIT`.
 *
 * A module root is a `telo.yaml` beneath a manifest directory, outside `tests/`,
 * `__fixtures__/` and `example/`: an artifact is cut from that directory, so the
 * text has to sit inside it. Test, fixture and example manifests declare nothing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const MIT_DIRECTORIES = [
  "cel",
  "sdk",
  "templating",
  "packages/glob",
  "packages/editor-protocol",
  "modules",
  "blueprints",
  "starters",
  "examples",
  "docs",
  "benchmarks",
  "apps/hub",
  "apps/hub-web",
  "apps/plan-approval",
  "apps/plan-approval-runner",
  "apps/plan-approval-runner-protocol",
  "apps/plan-approval-web",
];

/** The MIT directories whose `telo.yaml` files are module roots. */
const MANIFEST_DIRECTORIES = [
  "modules",
  "blueprints",
  "apps/hub",
  "apps/plan-approval",
  "apps/plan-approval-runner",
  "apps/plan-approval-runner-protocol",
];

const NOT_A_MODULE_ROOT = /(^|\/)(tests|__fixtures__|example)\//;
const NOT_A_PACKAGE = /(^|\/)(tests|__fixtures__)\//;

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 1 << 28,
})
  .split("\n")
  .filter((file) => file && existsSync(join(repoRoot, file)));

const read = (file) => readFileSync(join(repoRoot, file), "utf8");
const beneath = (file, directories) => directories.some((dir) => file.startsWith(`${dir}/`));
const isMit = (file) => beneath(file, MIT_DIRECTORIES);
const failures = [];

for (const dir of MIT_DIRECTORIES) {
  if (!existsSync(join(repoRoot, dir, "LICENSE"))) {
    failures.push(`${dir}/ is an MIT directory with no LICENSE of its own.`);
  }
}

// npm packages.
const packages = new Map();
for (const file of tracked) {
  if (posix.basename(file) !== "package.json" || NOT_A_PACKAGE.test(file)) continue;
  const pkg = JSON.parse(read(file));
  if (typeof pkg.name === "string") packages.set(pkg.name, { file, pkg });
}
for (const { file, pkg } of packages.values()) {
  if (!isMit(file)) {
    if (pkg.license === "MIT") {
      failures.push(`${file} declares MIT outside the MIT directories; add its directory to MIT_DIRECTORIES or restore its license.`);
    }
    continue;
  }
  if (pkg.license !== "MIT") {
    failures.push(`${file} sits in an MIT directory and declares ${JSON.stringify(pkg.license)}; it must declare "MIT".`);
  }
  const named = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...(pkg.teloInlines ?? []),
  ]);
  for (const name of named) {
    const target = packages.get(name);
    if (target && !isMit(target.file)) {
      failures.push(`${file} is MIT and depends on ${name} (${target.file}), which is not. An MIT package may depend only on MIT packages.`);
    }
  }
}

// Rust crates.
const crates = tracked.filter(
  (file) => posix.basename(file) === "Cargo.toml" && /^\[package\]/m.test(read(file)),
);
for (const file of crates) {
  const text = read(file);
  const license = text.match(/^license = "([^"]*)"/m)?.[1];
  const licenseFile = text.match(/^license-file = "([^"]*)"/m)?.[1];
  if (!license && !licenseFile) {
    failures.push(`${file} declares no license; a crate names "MIT" or the root license file.`);
    continue;
  }
  if (!isMit(file)) {
    if (license === "MIT") failures.push(`${file} declares MIT outside the MIT directories.`);
    continue;
  }
  if (license !== "MIT") {
    failures.push(`${file} sits in an MIT directory and must declare license = "MIT".`);
  }
  for (const [, relative] of text.matchAll(/\bpath = "([^"]+)"/g)) {
    const target = posix.join(posix.dirname(file), relative, "Cargo.toml");
    if (crates.includes(target) && !isMit(target)) {
      failures.push(`${file} is MIT and has a path dependency on ${target}, which is not.`);
    }
  }
}

// Module roots.
for (const file of tracked) {
  if (posix.basename(file) !== "telo.yaml") continue;
  if (!beneath(file, MANIFEST_DIRECTORIES) || NOT_A_MODULE_ROOT.test(file)) continue;
  const moduleDoc = read(file).split(/^---\s*$/m)[0];
  const license = moduleDoc.match(/^  license: *(.*?)\s*$/m)?.[1];
  if (license !== "MIT") {
    failures.push(`${file} declares ${license ? `license: ${license}` : "no license"}; a module root declares license: MIT.`);
  }
  if (!existsSync(join(repoRoot, posix.dirname(file), "LICENSE"))) {
    failures.push(`${posix.dirname(file)}/ is a module root with no LICENSE; its artifact would carry no license text.`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`\n${failures.length} license ${failures.length === 1 ? "problem" : "problems"}.`);
  process.exit(1);
}
console.log(
  `licenses ok — ${packages.size} packages, ${crates.length} crates, ${MIT_DIRECTORIES.length} MIT directories.`,
);
