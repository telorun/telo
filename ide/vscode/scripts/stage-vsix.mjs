// Stages exactly what `vsce package` ships into `dist/vsix/`: the extension
// bundle, the engine as a published release builds it (it reports exactly the
// line's version, never `+unreleased`), the staged LICENSE and the markdown with
// its links resolved to the unit's release tag. The release planner digests this
// directory (the unit's `payload:` command is this script) and `pack-vsix.mjs`
// packs it, so the digest recorded for a release is the digest of its `.vsix`.
//
// Also writes `dist/vsix.meta.json`, the unit's `metafile:`: the extension's
// esbuild inputs plus the engine's, which is how the planner sees that this unit
// inlines `packages/language-server`.
//
// stdout is the payload listing — one unit-relative path per line — so every
// other message goes to stderr.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extension = join(here, "..");
const root = join(extension, "..", "..");
const STAGE = "dist/vsix";

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: extension,
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : process.stderr, process.stderr],
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  return result.stdout;
}

/** Everything `vsce package` would put in the archive, unit-relative. */
function shippedFiles() {
  return run("pnpm", ["exec", "vsce", "ls", "--no-dependencies"], { capture: true })
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter(Boolean)
    .sort();
}

const { bundleEngine, checkProtocolGeneration } = await import(
  pathToFileURL(join(root, "packages", "language-server", "scripts", "build.mjs")).href
);

run(process.execPath, ["esbuild.mjs", "--no-engine"]);
rmSync(join(extension, STAGE), { recursive: true, force: true });
copyFileSync(join(root, "LICENSE"), join(extension, "LICENSE"));

const engine = join(extension, "dist", "engine", "language-server.mjs");
mkdirSync(dirname(engine), { recursive: true });
await checkProtocolGeneration();
await bundleEngine(engine, { published: true });
const engineMeta = JSON.parse(readFileSync(engine.replace(/\.mjs$/, ".meta.json"), "utf8"));
rmSync(engine.replace(/\.mjs$/, ".meta.json"));

const extensionMeta = JSON.parse(readFileSync(join(extension, "dist", "extension.meta.json"), "utf8"));
const inputs = { ...extensionMeta.inputs };
for (const input of Object.keys(engineMeta.inputs ?? {})) {
  if (input.includes(":")) continue;
  inputs[relative(extension, join(root, "packages", "language-server", input)).split("\\").join("/")] = {};
}
writeFileSync(join(extension, "dist", "vsix.meta.json"), JSON.stringify({ inputs }, null, 2) + "\n");

// The links are rewritten in place for the copy and put back, as a pack does.
const rewrite = join(root, "scripts", "rewrite-pack-links.mjs");
const files = shippedFiles();
try {
  run(process.execPath, [rewrite, "."]);
  for (const file of files) {
    mkdirSync(dirname(join(extension, STAGE, file)), { recursive: true });
    copyFileSync(join(extension, file), join(extension, STAGE, file));
  }
} finally {
  run(process.execPath, [rewrite, ".", "--restore"]);
}

process.stdout.write(files.map((file) => `${STAGE}/${file}`).join("\n") + "\n");
