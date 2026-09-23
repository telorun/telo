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
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(CLI_DIR, "..", "..");

/**
 * The Node runtime every binary carries, whatever built it — read from the CLI's
 * own source of truth, which `telo package` reads too.
 *
 * Taking the building machine's own version instead made the artifact a
 * property of the runner: a runner defaulting to Node 22 asked nodejs.org for
 * `node-v22.x-linux-x64-musl.tar.gz`, which does not exist — official musl
 * builds begin at 24 — and two targets released on the same day could ship
 * different runtimes. Stating it in ONE place is the same argument one level
 * out: the build injects the runtime and the packager warms native layers for
 * its ABI, and two copies of that pair drift into a packaged app that cannot
 * open its own addons. `--node-version` overrides for a one-off.
 */
const { CARRIER_NODE_VERSION: NODE_RUNTIME_VERSION, CARRIER_NODE_ABI } = await import(
  pathToFileURL(path.join(CLI_DIR, "dist", "carrier-runtime.js")).href
);

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
    "@telorun/templating": read("templating/nodejs/package.json"),
    "@telorun/debug-ui": read("packages/debug-ui/package.json"),
    ajv: dep("ajv"),
    "ajv-formats": dep("ajv-formats"),
    yaml: dep("yaml"),
    // The executable this build embeds. The binary keys its unpacked copy on
    // this, so an upgrade unpacks its own rather than driving the previous
    // version's — esbuild refuses a host/binary version mismatch, which would
    // surface as a controller build failure with no mention of a stale file.
    esbuild: dep("esbuild"),
    "node-abi": CARRIER_NODE_ABI,
    // WHICH build this is, not which version. A version number is not an
    // identity for an unreleased tree, and `telo package` is the one place that
    // matters: it may download a carrier only when the CLI asking for it IS that
    // release. Set by the release workflow; absent here means a build of one's
    // own, which is allowed to be the carrier for its own platform and nothing
    // else.
    build: process.env.TELO_RELEASE_BUILD === "1" ? "release" : "local",
  };
}

/**
 * Give a CommonJS `require('ws')` the CommonJS `ws`.
 *
 * This build resolves the `import` condition, under which `ws` answers with an
 * ESM wrapper exporting `WebSocketServer` and no `Server`. `@fastify/websocket`
 * — which carries the session byte channel — does `require('ws')` and then
 * reads `.Server` off it, so the bundled runner threw `WebSocket2.Server is not
 * a constructor` the moment a client attached, in the binary only.
 *
 * Resolved FROM THE IMPORTER rather than by walking a path of our own, so the
 * answer is whatever that consumer's own `require` would have produced and the
 * rule holds for any package that requires `ws`, at any depth, under any
 * `node_modules` layout. Dropping the `import` condition wholesale would fix
 * the class too, and break every package whose ESM entry is the one that works.
 */
const requireCjsResolution = {
  name: "cjs-require-resolution",
  setup(build) {
    build.onResolve({ filter: /^ws$/ }, (args) => {
      if (args.kind !== "require-call") return null;
      return { path: createRequire(args.importer).resolve("ws") };
    });
  },
};

async function bundle(stagingDir, versions) {
  const esbuild = require("esbuild");
  const outfile = path.join(stagingDir, "telo.cjs");
  await esbuild.build({
    plugins: [requireCjsResolution],
    entryPoints: [path.join(CLI_DIR, "dist", "standalone", "entry.js")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    conditions: ["import", "node"],
    logLevel: "warning",
    // esbuild's own `main.js` calls `require.resolve("esbuild")` from
    // `pkgForSomeOtherPlatform`, a branch that exists only to word the error an
    // install with the wrong platform package gets. The binary never reaches it:
    // the host names the executable through `ESBUILD_BINARY_PATH` before the
    // first build. Marking esbuild external, which is what the warning asks for,
    // is the one thing this bundle must not do.
    logOverride: { "require-resolve-not-external": "silent" },
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

/**
 * The Node runtime to inject into: the official build for the target, at the
 * pinned version, downloaded and cached under the staging dir.
 *
 * The running Node is reused only when it IS that build — same target, same
 * version. Reusing it whenever the target matched was how a macOS binary came
 * to be carved out of the runner's own signed-and-hardened Node, which
 * `codesign --remove-signature` then refused to strip.
 */
async function runtimeBinary(target, stagingDir, nodeVersion) {
  const spec = TARGETS[target];
  const version = nodeVersion ?? NODE_RUNTIME_VERSION;
  if (target === hostTarget() && version === process.versions.node) {
    // The one place the build can SEE the runtime it injects: check the pair
    // rather than trusting a comment that they move together. A packaged app
    // warms its native layers for this ABI, so a wrong one is an app that cannot
    // open the addons travelling inside it.
    if (process.versions.modules !== CARRIER_NODE_ABI) {
      throw new Error(
        `carrier-runtime.ts says Node ${version} reports abi ${CARRIER_NODE_ABI}, but this ` +
          `Node ${process.versions.node} reports ${process.versions.modules}. Fix CARRIER_NODE_ABI.`,
      );
    }
    return process.execPath;
  }
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

/**
 * esbuild's executable for the target.
 *
 * An install carries only the HOST's per-platform package, so every other
 * target's is fetched from the registry at the version the workspace resolved —
 * the build already downloads a Node runtime, and one npm tarball is the same
 * kind of fetch. The alternative was a workflow step naming each cross target,
 * which silently omitted two of the four and failed at the build.
 */
async function esbuildExecutable(target, stagingDir) {
  const pkg = TARGETS[target].esbuild;
  // Anchored at esbuild itself: its per-platform packages are optional
  // dependencies of esbuild, which under pnpm puts them in esbuild's own
  // directory rather than anywhere this script can reach by name.
  const fromKernel = createRequire(path.join(REPO_ROOT, "kernel", "nodejs", "package.json"));
  const fromEsbuild = createRequire(fromKernel.resolve("esbuild/package.json"));
  const version = JSON.parse(
    fs.readFileSync(fromKernel.resolve("esbuild/package.json"), "utf8"),
  ).version;

  let root;
  try {
    root = path.dirname(fromEsbuild.resolve(`${pkg}/package.json`));
  } catch {
    root = await fetchPackage(pkg, version, path.join(stagingDir, "esbuild"));
  }
  const candidates = [path.join(root, "bin", "esbuild"), path.join(root, "esbuild.exe")];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`${pkg}@${version} carries no esbuild executable`);
  fs.chmodSync(found, 0o755);
  return found;
}

/** Unpack one npm package into `dir`, returning the directory its files landed
 *  in. Tarball members are prefixed `package/`, which is stripped. */
async function fetchPackage(name, version, dir) {
  const target = path.join(dir, `${name.replace(/[@/]/g, "-")}-${version}`);
  if (fs.existsSync(target)) return target;
  const scope = name.startsWith("@") ? name.split("/")[1] : name;
  const url = `https://registry.npmjs.org/${name}/-/${scope}-${version}.tgz`;
  process.stderr.write(`fetching ${url}\n`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not fetch ${url}: HTTP ${response.status}`);
  fs.mkdirSync(target, { recursive: true });
  const archive = `${target}.tgz`;
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  execFileSync("tar", ["xzf", archive, "-C", target, "--strip-components=1"], { stdio: "inherit" });
  return target;
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
  const esbuildBin = await esbuildExecutable(args.target, stagingDir);

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
  // postject drives LIEF, whose ELF reader emits `Can't find string offset for
  // section name` once per note section of the official Node runtime — a remark
  // about the input binary, not about the injection, and not fixable from here.
  // Its output is held and replayed only when the injection fails, so the exit
  // code decides what is a failure rather than a pattern over someone else's
  // text.
  try {
    execFileSync(
      process.execPath,
      [createRequire(path.join(CLI_DIR, "package.json")).resolve("postject/dist/cli.js"), ...postjectArgs],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    process.stderr.write(String(err?.stdout ?? ""));
    process.stderr.write(String(err?.stderr ?? ""));
    throw new Error(`postject could not inject NODE_SEA_BLOB into ${output}: ${err?.message ?? err}`);
  }

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
