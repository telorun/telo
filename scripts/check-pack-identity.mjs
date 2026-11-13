#!/usr/bin/env node
// The publish guard (`prepack`, after the published build): a tarball of a telo
// line package must carry exactly its own version. A build of the tree reports
// `V+unreleased`; the package's `prepack` regenerates its version module with
// `--published` and rebuilds, and this asks both what ships — the generated
// source (the package publishes `src/**`) and the built module, imported — so a
// stale `dist` or a skipped regeneration refuses the pack instead of publishing
// an engine that names another build.
//
// Usage: node scripts/check-pack-identity.mjs <analyzer|cel|kernel>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VERSION_MODULES, versionModules } from "./generate-telo-version.mjs";
import { teloGeneration } from "./version-line.mjs";

/** The exported constant each package's built module must hold, and its value. */
const EXPECTED = {
  analyzer: (generation) => ["TELO_RUNNING_SURFACE", generation.surface],
  cel: (generation) => ["ENGINE_VERSION", generation.identity],
  kernel: (generation) => ["TELO_RUNTIME_VERSION", generation.identity],
};

function refuse(key, message) {
  console.error(`${key}: refusing to pack — ${message}`);
  process.exit(1);
}

const key = process.argv[2];
if (!EXPECTED[key]) refuse(key ?? "check-pack-identity", `name one of ${Object.keys(EXPECTED).join(", ")}.`);
const { pkg, file } = VERSION_MODULES[key];
const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
const generation = teloGeneration({ published: true });
if (generation.version !== version) {
  refuse(key, `its version ${version} is not the line's recorded ${generation.version}; the line releases one version.`);
}
if (readFileSync(join(pkg, file), "utf8") !== versionModules({ published: true })[key]) {
  refuse(key, `${file} is not the published version module of ${version}; the prepack must run generate-telo-version.mjs --published.`);
}
const built = join(pkg, "dist", file.replace(/^src[\\/]/, "").replace(/\.ts$/, ".js"));
const [name, expected] = EXPECTED[key](generation);
const actual = (await import(pathToFileURL(built).href))[name];
if (actual !== expected) {
  refuse(key, `${built} exports ${name} = ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}; rebuild it in the prepack.`);
}
