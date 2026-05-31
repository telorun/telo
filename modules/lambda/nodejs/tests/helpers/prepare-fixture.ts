import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");

/** Workspace packages packed + npm-installed into the fixture's `node_modules`
 *  so the bootstrap's `import { Kernel } from "@telorun/kernel"` resolves. The
 *  copied module controllers (below) resolve their `@telorun/sdk` peer from
 *  here via Node's upward `node_modules` walk. */
const WORKSPACE_PACKAGES = [
  { name: "@telorun/kernel", dir: "kernel/nodejs" },
  { name: "@telorun/sdk", dir: "sdk/nodejs" },
  { name: "@telorun/analyzer", dir: "analyzer/nodejs" },
  { name: "@telorun/templating", dir: "templating/nodejs" },
];

/** Telo modules copied verbatim into the fixture (telo.yaml + built `nodejs/`)
 *  so fixtures import them by relative path and `local_path` controllers route
 *  to this LIVE workspace code instead of a published registry version — no
 *  version strings to maintain, and the e2e exercises what's about to ship.
 *  `package.json` is the package name (used to rewrite sibling `workspace:*`
 *  deps), `dir` the workspace source, `module` the fixture-relative folder. */
const FIXTURE_MODULES = [
  { package: "@telorun/lambda", dir: "modules/lambda", module: "lambda" },
  {
    package: "@telorun/http-dispatch",
    dir: "modules/http-dispatch",
    module: "http-dispatch",
  },
  { package: "@telorun/javascript", dir: "modules/javascript", module: "javascript" },
  { package: "@telorun/type", dir: "modules/type", module: "type" },
];

/** Fixture-root-relative `source:` for each module's `Telo.Import`. Consumed by
 *  the manifest helpers so import paths and the copied tree stay in lockstep. */
export const MODULE_SOURCES = {
  lambda: "./modules/lambda",
  javascript: "./modules/javascript",
  type: "./modules/type",
} as const;

/** Cached across all fixtures in a vitest run — packing + npm-installing is
 *  the slowest part (~30-60s). Each fixture clones this tree before layering
 *  its own telo.yaml + bootstrap on top. */
let preparedRoot: Promise<string> | null = null;

interface PackedTarballs {
  /** Map from package name → absolute path of the packed `.tgz`. */
  tarballs: Map<string, string>;
  /** Temp dir holding the tarballs. */
  packDir: string;
}

/** Everything packed into the fixture-root `node_modules`: the workspace
 *  runtime packages plus the modules' `nodejs/` controllers. Packing the
 *  modules here (not just copying their trees) materialises their transitive
 *  deps (`@telorun/http-dispatch`, typebox, cel-js, …) at the fixture root, so
 *  a `local_path` controller loaded from the copied tree resolves them via
 *  Node's upward `node_modules` walk. */
const PACKED_PACKAGES = [
  ...WORKSPACE_PACKAGES,
  ...FIXTURE_MODULES.map((m) => ({ name: m.package, dir: `${m.dir}/nodejs` })),
];

async function pnpmPackAll(): Promise<PackedTarballs> {
  const packDir = mkdtempSync(join(tmpdir(), "telo-lambda-e2e-pack-"));
  const tarballs = new Map<string, string>();
  for (const pkg of PACKED_PACKAGES) {
    const pkgDir = join(REPO_ROOT, pkg.dir);
    // `--config.ignore-scripts=true` skips the workspace-internal
    // prepack-bake-overrides hook, which expects pnpm to rewrite workspace:
    // specifiers before prepack — current pnpm rewrites them after. pnpm still
    // rewrites the workspace: protocol into concrete versions in the produced
    // tarball, so the tarballs install cleanly via npm.
    const out = execFileSync(
      "pnpm",
      ["pack", "--pack-destination", packDir, "--config.ignore-scripts=true"],
      { cwd: pkgDir, encoding: "utf-8" },
    );
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const tarballPath = lines[lines.length - 1]!;
    if (!existsSync(tarballPath)) {
      throw new Error(
        `pnpm pack didn't produce a tarball for ${pkg.name} at ${tarballPath}. Output:\n${out}`,
      );
    }
    tarballs.set(pkg.name, tarballPath);
  }
  return { tarballs, packDir };
}

/** Writes a synthetic `package.json` that file:-depends on each packed
 *  tarball and runs `npm install` once to produce a fully-resolved
 *  node_modules tree. */
async function buildPreparedRoot(): Promise<string> {
  const { tarballs } = await pnpmPackAll();
  const root = mkdtempSync(join(tmpdir(), "telo-lambda-e2e-root-"));

  const deps: Record<string, string> = {};
  for (const [name, tarball] of tarballs) {
    deps[name] = `file:${tarball}`;
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "lambda-e2e-fixture-root",
        version: "0.0.0",
        private: true,
        dependencies: deps,
      },
      null,
      2,
    ),
  );

  execFileSync("npm", ["install", "--no-package-lock", "--silent"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });

  await copyModuleManifests(root);
  await stageControllers(root);

  return root;
}

/** Copies each module's telo.yaml into `<root>/modules/<name>/` so fixtures
 *  import it by relative path, stripping the `?local_path=` qualifier off every
 *  controller PURL. Without `local_path` the kernel resolves the controller as
 *  a `kind: "registry"` spec — whose fast path matches by installed *version*
 *  (`stageControllers` pre-places the right one) rather than by a `file:` path.
 *  That's what survives the host→container bind-mount: the registry fast path
 *  needs no boot-time `npm install`, so the offline AWS Lambda container never
 *  reaches for the network. */
async function copyModuleManifests(root: string): Promise<void> {
  for (const mod of FIXTURE_MODULES) {
    const srcDir = join(REPO_ROOT, mod.dir);
    const manifest = readFileSync(join(srcDir, "telo.yaml"), "utf-8").replaceAll(
      /\?local_path=[^#"\s]+/g,
      "",
    );
    const destDir = join(root, "modules", mod.module);
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "telo.yaml"), manifest);
  }
}

/** Pre-places real copies of the module controllers (packed + installed into
 *  the fixture-root `node_modules` above) under `.telo/npm/node_modules/` so the
 *  kernel's registry fast path finds the LIVE-version package already on disk
 *  and skips installing. `@telorun/sdk` is left to the kernel's realm-collapse
 *  bootstrap, which resolves it offline from the fixture-root `node_modules`. */
async function stageControllers(root: string): Promise<void> {
  const stageRoot = join(root, ".telo", "npm", "node_modules");
  for (const mod of FIXTURE_MODULES) {
    const installed = join(root, "node_modules", mod.package);
    const version = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf-8"),
    ).version;
    if (!version) {
      throw new Error(`Packed module ${mod.package} is missing from ${installed}.`);
    }
    await cp(installed, join(stageRoot, ...mod.package.split("/")), { recursive: true });
  }
}

/** Returns the prepared root path. Builds it on first call; subsequent calls
 *  resolve to the same path. */
export function getPreparedRoot(): Promise<string> {
  if (!preparedRoot) preparedRoot = buildPreparedRoot();
  return preparedRoot;
}

export interface FixtureSpec {
  /** Suffix for the fixture's temp-dir name. */
  name: string;
  /** Contents of the user's `Telo.Application` telo.yaml. */
  telo: string;
  /** Picks which bootstrap is materialised — managed → `index.mjs`,
   *  custom → `bootstrap` (executable). Both are copied verbatim from the
   *  workspace's `@telorun/lambda` package. */
  mode: "managed" | "custom";
}

export interface Fixture {
  /** Absolute path to the fixture root — bind-mount this as `/var/task`. */
  dir: string;
  /** Removes the fixture dir. */
  cleanup: () => void;
}

/** Materialises a per-test fixture: clones the prepared root (which already
 *  carries the copied module manifests and the staged `.telo/npm/` controllers),
 *  writes the fixture's telo.yaml, and copies the right bootstrap into place.
 *  No `telo install` is needed — every controller is pre-staged at its LIVE
 *  version, so the offline AWS Lambda container resolves them without a network. */
export async function buildFixture(spec: FixtureSpec): Promise<Fixture> {
  const root = await getPreparedRoot();
  const dir = mkdtempSync(join(tmpdir(), `telo-lambda-e2e-${spec.name}-`));

  // Real file copies (not symlinks) so the bind-mount sees the full tree.
  for (const entry of readdirSync(root)) {
    await cp(join(root, entry), join(dir, entry), { recursive: true });
  }

  writeFileSync(join(dir, "telo.yaml"), spec.telo);

  const lambdaBootstraps = resolve(REPO_ROOT, "modules/lambda/nodejs");
  if (spec.mode === "managed") {
    const src = await readFile(join(lambdaBootstraps, "managed.mjs"), "utf-8");
    writeFileSync(join(dir, "index.mjs"), src);
  } else {
    const src = await readFile(join(lambdaBootstraps, "custom.mjs"), "utf-8");
    writeFileSync(join(dir, "bootstrap"), src, { mode: 0o755 });
  }

  return {
    dir,
    cleanup: () => {
      // The container ran as root and chowned bind-mounted files; tolerate
      // EACCES from rmSync — these are temp dirs the OS will GC anyway.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EACCES") throw err;
      }
    },
  };
}
