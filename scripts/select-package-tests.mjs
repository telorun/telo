#!/usr/bin/env node
// Decides which workspace packages a pull request's CI builds and tests, and
// which of the suites that are not per-package it runs at all.
//
//   git diff --name-only origin/main...HEAD | node scripts/select-package-tests.mjs
//
// Reads the changed paths on stdin, one per line, and prints one JSON object:
//
//   mode                "full" | "selected" | "none"
//   reason              why, in a sentence — written to the job summary
//   packages            the packages whose tests run (empty unless "selected")
//   testArgs            pnpm `--filter` pairs for `pnpm -r … test`
//   buildArgs           pnpm `--filter` pairs for `pnpm -r … run build`
//   packageIntegration  whether a selected package has a `test:integration`
//   suites              whether the example / starter / blueprint / plan-approval
//                       suites and the cross-platform manifest checks run
//   rust                whether the cargo job runs
//
// CONSERVATIVE BY CONSTRUCTION. A package's tests are selected only when every
// changed file is either inside a package outside the runtime and the standard
// library, or something no test reads. Anything else runs everything:
//
//   - the runtime and the standard library (`RUNTIME`): their tests read each
//     other's manifests and built output through paths no `package.json`
//     declares, so the dependency graph is not the whole truth there;
//   - what every package stands on (`SHARED`);
//   - a file no package owns that is not known to be inert (`INERT`).
//
// The caller fails open the same way: no answer from this script is a full run.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RUNTIME = /^(kernel|analyzer|sdk|templating|cel|cli|modules)\//;
const SHARED =
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|vitest[^/]*|\.npmrc|\.github\/workflows\/test\.yml|scripts\/select-package-tests\.mjs)$/;
const INERT = /\.md$|^(docs|\.changeset|\.changes|\.claude|\.github|\.vscode)\//;
const SUITES = /^(examples|starters|blueprints|apps\/plan-approval[^/]*)\//;
const RUST = /(^|\/)rust\/|\.rs$|(^|\/)Cargo\.(toml|lock)$|^rust-toolchain/;

/** A selected package's tests may start the CLI without declaring it. */
const ALWAYS_BUILT = "@telorun/cli";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function workspacePackages() {
  const listed = JSON.parse(
    execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    }),
  );
  const packages = [];
  for (const entry of listed) {
    const dir = relative(ROOT, entry.path).split(sep).join("/");
    if (!entry.name || dir === "") continue;
    const manifest = JSON.parse(readFileSync(join(entry.path, "package.json"), "utf8"));
    packages.push({
      name: entry.name,
      dir,
      scripts: manifest.scripts ?? {},
      dependsOn: DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})),
    });
  }
  return packages;
}

function ownerOf(file, packages) {
  let owner = null;
  for (const pkg of packages) {
    if (!file.startsWith(`${pkg.dir}/`)) continue;
    if (!owner || pkg.dir.length > owner.dir.length) owner = pkg;
  }
  return owner;
}

function withDependents(names, packages) {
  const reached = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const pkg of packages) {
      if (reached.has(pkg.name)) continue;
      if (!pkg.dependsOn.some((name) => reached.has(name))) continue;
      reached.add(pkg.name);
      grew = true;
    }
  }
  return reached;
}

const filters = (names, suffix = "") => names.flatMap((name) => ["--filter", `${name}${suffix}`]);

export function selectPackageTests(changed, packages) {
  const everything = (reason) => ({
    mode: "full",
    reason,
    packages: [],
    testArgs: [],
    buildArgs: [],
    packageIntegration: true,
    suites: true,
    rust: true,
  });

  const touched = new Set();
  let suites = false;
  let rust = false;
  for (const file of changed) {
    if (RUNTIME.test(file)) return everything(`\`${file}\` is part of the runtime or the standard library`);
    if (SHARED.test(file)) return everything(`\`${file}\` is something every package stands on`);
    if (SUITES.test(file)) suites = true;
    if (RUST.test(file)) rust = true;
    const owner = ownerOf(file, packages);
    if (owner) touched.add(owner.name);
    else if (!INERT.test(file) && !SUITES.test(file) && !RUST.test(file)) {
      return everything(`\`${file}\` belongs to no package and is not known to be inert`);
    }
  }

  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const selected = [...withDependents(touched, packages)].sort();
  const runtime = selected.find((name) => RUNTIME.test(`${byName.get(name).dir}/`));
  if (runtime) return everything(`\`${runtime}\`, in the runtime, depends on a changed package`);
  const has = (script) => selected.filter((name) => script in byName.get(name).scripts);
  if (selected.length === 0) {
    return {
      mode: "none",
      reason: "No package is reached by this change",
      packages: [],
      testArgs: [],
      buildArgs: [],
      packageIntegration: false,
      suites,
      rust,
    };
  }
  return {
    mode: "selected",
    reason: `Changed: ${[...touched].sort().join(", ")}`,
    packages: selected,
    testArgs: filters(has("test")),
    buildArgs: filters([...new Set([...has("build"), ALWAYS_BUILT])], "..."),
    packageIntegration: has("test:integration").length > 0,
    suites,
    rust,
  };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const changed = readFileSync(0, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  process.stdout.write(`${JSON.stringify(selectPackageTests(changed, workspacePackages()))}\n`);
}
