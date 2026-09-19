#!/usr/bin/env node
/**
 * Build the standalone `telo` executable for one target.
 *
 * The output is Node's own single-executable format: the whole CLI bundled to
 * one script, injected into an official Node runtime together with esbuild's
 * executable as an embedded asset. A machine running it needs no Node.js, no
 * package manager and no `node_modules`.
 *
 *   node scripts/build-standalone.mjs [--target <os>-<arch>[-musl]] [--out <dir>]
 *                                     [--node-version <v>] [--keep-staging]
 *
 * With no `--target` it builds for the host, reusing the running Node binary
 * instead of downloading one, which is what makes a local build fast.
 *
 * Three things the bundle cannot discover at runtime are decided here:
 *
 *  - **Versions are baked** (`__TELO_BAKED_VERSIONS__`). They key the analysis
 *    and validator caches, and a binary has no `package.json` to read them
 *    from. Left undetermined the kernel disables those caches rather than
 *    keying them on a placeholder, so getting this wrong is slow, never wrong —
 *    but it should not be wrong.
 *  - **`import.meta.url` is rewritten** to the executable's own path. The
 *    output is CommonJS, where it does not exist; every remaining use in the
 *    kernel is an anchor for `createRequire`, which resolves nothing inside a
 *    binary and is expected not to.
 *  - **esbuild stays out of the bundle's import graph as a package** but its
 *    JavaScript API is inlined, so a source build works with only the embedded
 *    executable unpacked beside it.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(CLI_DIR, "..", "..");

/**
 * Every target that has an official Node build, named in **Telo's own platform
 * vocabulary** — `<os>-<arch>[-<libc>]`, the tokens a `native:` entry, a
 * platform-qualified controller PURL and `telo install --platform` already use.
 * Node's own spelling (`linux-x64`, `win32-x64`) is a second vocabulary for the
 * same axis, and these names end up in permanent download URLs.
 *
 * Linux arm64 musl is deliberately absent: nodejs.org publishes no such
 * runtime, so there is nothing to inject into. A module may still ship a native
 * file for that tuple — the npm-installed CLI runs there — but the binary
 * cannot exist.
 */
const TARGETS = {
  "linux-amd64-gnu": { nodeFile: "linux-x64", esbuild: "@esbuild/linux-x64", exe: "" },
  "linux-amd64-musl": { nodeFile: "linux-x64-musl", esbuild: "@esbuild/linux-x64", exe: "" },
  "linux-arm64-gnu": { nodeFile: "linux-arm64", esbuild: "@esbuild/linux-arm64", exe: "" },
  "darwin-amd64": { nodeFile: "darwin-x64", esbuild: "@esbuild/darwin-x64", exe: "" },
  "darwin-arm64": { nodeFile: "darwin-arm64", esbuild: "@esbuild/darwin-arm64", exe: "" },
  "windows-amd64": { nodeFile: "win-x64", esbuild: "@esbuild/win32-x64", exe: ".exe" },
  "windows-arm64": { nodeFile: "win-arm64", esbuild: "@esbuild/win32-arm64", exe: ".exe" },
};

function parseArgs(argv) {
  const args = { target: hostTarget(), out: path.join(CLI_DIR, "dist-standalone"), keepStaging: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") args.target = argv[++i];
    else if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else if (argv[i] === "--node-version") args.nodeVersion = argv[++i];
    else if (argv[i] === "--keep-staging") args.keepStaging = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!TARGETS[args.target]) {
    throw new Error(
      `unsupported target "${args.target}". Supported: ${Object.keys(TARGETS).join(", ")}`,
    );
  }
  return args;
}

/** This machine, in the same vocabulary. */
function hostTarget() {
  const os = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform];
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  if (!os || !arch) throw new Error(`no standalone target for ${process.platform}/${process.arch}`);
  const libc = os === "linux" ? (isMuslHost() ? "-musl" : "-gnu") : "";
  return `${os}-${arch}${libc}`;
}

/** Whether this Linux host is musl-based, read from the interpreter the running
 *  Node was linked against rather than from a distro name. */
function isMuslHost() {
  try {
    return execFileSync("ldd", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .toLowerCase()
      .includes("musl");
  } catch (err) {
    return /musl/i.test(String(err?.stderr ?? ""));
  }
}

/** The versions the caches are keyed by, read from the workspace being built. */
function bakedVersions() {
  const read = (relative) =>
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relative), "utf8")).version;
  // ajv and ajv-formats belong to the kernel, not to this package, so they are
  // resolved the way the kernel resolves them — anchored at the kernel's own
  // manifest. Under pnpm a dependency of a sibling package is not reachable
  // from here by name.
  const fromKernel = createRequire(path.join(REPO_ROOT, "kernel", "nodejs", "package.json"));
  const dep = (name) =>
    JSON.parse(fs.readFileSync(fromKernel.resolve(`${name}/package.json`), "utf8")).version;
  return {
    "@telorun/cli": read("cli/nodejs/package.json"),
    "@telorun/kernel": read("kernel/nodejs/package.json"),
    "@telorun/analyzer": read("analyzer/nodejs/package.json"),
    "@telorun/debug-ui": read("packages/debug-ui/package.json"),
    ajv: dep("ajv"),
    "ajv-formats": dep("ajv-formats"),
    // The executable this build embeds. The binary keys its unpacked copy on
    // this, so an upgrade unpacks its own rather than driving the previous
    // version's — esbuild refuses a host/binary version mismatch, which would
    // surface as a controller build failure with no mention of a stale file.
    esbuild: dep("esbuild"),
  };
}

async function bundle(stagingDir, versions) {
  const esbuild = require("esbuild");
  const outfile = path.join(stagingDir, "telo.cjs");
  await esbuild.build({
    entryPoints: [path.join(CLI_DIR, "dist", "standalone", "entry.js")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    conditions: ["import", "node"],
    logLevel: "warning",
    define: {
      __TELO_BAKED_VERSIONS__: JSON.stringify(versions),
      // Rewritten rather than left to esbuild's empty substitute for CommonJS,
      // which would silently turn every anchored resolution into one rooted at
      // the process cwd.
      "import.meta.url": "__teloMetaUrl",
    },
    banner: { js: 'var __teloMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  });
  return outfile;
}

/** The Node runtime to inject into: the running one for a host build, else the
 *  official build for the target, downloaded and cached under the staging dir. */
async function runtimeBinary(target, stagingDir, nodeVersion) {
  const spec = TARGETS[target];
  if (target === hostTarget() && !nodeVersion) return process.execPath;
  const version = nodeVersion ?? process.versions.node;
  const isWindows = spec.exe === ".exe";
  const archive = isWindows
    ? `node-v${version}-${spec.nodeFile}.zip`
    : `node-v${version}-${spec.nodeFile}.tar.gz`;
  const url = `https://nodejs.org/dist/v${version}/${archive}`;
  const downloadDir = path.join(stagingDir, "runtime");
  fs.mkdirSync(downloadDir, { recursive: true });
  const archivePath = path.join(downloadDir, archive);
  if (!fs.existsSync(archivePath)) {
    process.stderr.write(`fetching ${url}\n`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not fetch ${url}: HTTP ${response.status}`);
    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
  }
  const extractDir = path.join(downloadDir, target);
  fs.mkdirSync(extractDir, { recursive: true });
  if (isWindows) {
    execFileSync("unzip", ["-o", "-q", archivePath, "-d", extractDir], { stdio: "inherit" });
    return path.join(extractDir, `node-v${version}-${spec.nodeFile}`, "node.exe");
  }
  execFileSync("tar", ["xzf", archivePath, "-C", extractDir], { stdio: "inherit" });
  return path.join(extractDir, `node-v${version}-${spec.nodeFile}`, "bin", "node");
}

/** esbuild's executable for the target, out of the per-platform npm package. */
function esbuildExecutable(target) {
  const pkg = TARGETS[target].esbuild;
  // Anchored at esbuild itself: its per-platform packages are optional
  // dependencies of esbuild, which under pnpm puts them in esbuild's own
  // directory rather than anywhere this script can reach by name.
  const fromKernel = createRequire(path.join(REPO_ROOT, "kernel", "nodejs", "package.json"));
  const fromEsbuild = createRequire(fromKernel.resolve("esbuild/package.json"));
  const root = path.dirname(fromEsbuild.resolve(`${pkg}/package.json`));
  const candidates = [path.join(root, "bin", "esbuild"), path.join(root, "esbuild.exe")];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `${pkg} is installed but carries no executable. Install it for this target before building.`,
    );
  }
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = TARGETS[args.target];
  const stagingDir = path.join(os.tmpdir(), `telo-standalone-${args.target}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(args.out, { recursive: true });

  const versions = bakedVersions();
  process.stderr.write(`building telo ${versions["@telorun/cli"]} for ${args.target}\n`);

  const script = await bundle(stagingDir, versions);
  const esbuildBin = esbuildExecutable(args.target);

  const seaConfig = path.join(stagingDir, "sea-config.json");
  const blob = path.join(stagingDir, "telo.blob");
  fs.writeFileSync(
    seaConfig,
    `${JSON.stringify(
      {
        main: script,
        output: blob,
        disableExperimentalSEAWarning: true,
        assets: { esbuild: esbuildBin },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

  const output = path.join(args.out, `telo${spec.exe}`);
  fs.copyFileSync(await runtimeBinary(args.target, stagingDir, args.nodeVersion), output);
  fs.chmodSync(output, 0o755);

  // macOS refuses to run a signed binary whose contents changed, so the
  // signature comes off before injection and an ad-hoc one goes back on after.
  // Injecting first and signing second is the only order that produces a
  // runnable file.
  const isMac = args.target.startsWith("darwin");
  if (isMac) run("codesign", ["--remove-signature", output]);

  const postjectArgs = [
    output,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ];
  if (isMac) postjectArgs.push("--macho-segment-name", "NODE_SEA");
  execFileSync(
    process.execPath,
    [createRequire(path.join(CLI_DIR, "package.json")).resolve("postject/dist/cli.js"), ...postjectArgs],
    { stdio: "inherit" },
  );

  if (isMac) run("codesign", ["--sign", "-", output]);

  if (!args.keepStaging) fs.rmSync(path.join(stagingDir, "telo.cjs"), { force: true });

  const size = fs.statSync(output).size;
  const digest = createHash("sha256").update(fs.readFileSync(output)).digest("hex");
  process.stderr.write(
    `${output}\n  ${(size / 1024 / 1024).toFixed(1)} MB\n  sha256:${digest}\n`,
  );
  fs.writeFileSync(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`);
}

/** Run a command that only exists on one platform, reporting what was missing
 *  rather than an `ENOENT` naming a path nobody wrote. */
function run(command, commandArgs) {
  try {
    execFileSync(command, commandArgs, { stdio: "inherit" });
  } catch (err) {
    throw new Error(
      `"${command}" failed (${err?.message ?? err}). A macOS build needs Xcode's command line tools.`,
    );
  }
}

await main();
