import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");

/** Workspace packages packed + npm-installed into the fixture's `node_modules`
 *  so the bootstrap's `import { Kernel } from "@telorun/kernel"` resolves.
 *  Controllers (lambda, javascript, type, ...) are pulled in by `telo install`
 *  against the public registry — they don't need to live in the bootstrap's
 *  resolution path. */
const WORKSPACE_PACKAGES = [
  { name: "@telorun/kernel", dir: "kernel/nodejs" },
  { name: "@telorun/sdk", dir: "sdk/nodejs" },
  { name: "@telorun/analyzer", dir: "analyzer/nodejs" },
  { name: "@telorun/templating", dir: "templating/nodejs" },
];

/** Registry id used by fixture manifests' `Telo.Import` of the Lambda module.
 *  Resolved by `telo install` from the public Telo registry. */
export const LAMBDA_LIB_PATH = "aws/lambda@0.2.1";

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

async function pnpmPackAll(): Promise<PackedTarballs> {
  const packDir = mkdtempSync(join(tmpdir(), "telo-lambda-e2e-pack-"));
  const tarballs = new Map<string, string>();
  for (const pkg of WORKSPACE_PACKAGES) {
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

  return root;
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

/** Materialises a per-test fixture: clones the prepared root, writes the
 *  fixture's telo.yaml, runs `telo install` to pre-populate `.telo/npm/`,
 *  and copies the right bootstrap into place. */
export async function buildFixture(spec: FixtureSpec): Promise<Fixture> {
  const root = await getPreparedRoot();
  const dir = mkdtempSync(join(tmpdir(), `telo-lambda-e2e-${spec.name}-`));

  // Real file copies (not symlinks) so the bind-mount sees the full tree.
  for (const entry of readdirSync(root)) {
    await cp(join(root, entry), join(dir, entry), { recursive: true });
  }

  writeFileSync(join(dir, "telo.yaml"), spec.telo);

  // Pre-populate `.telo/npm/` from the public registry on the host — the
  // AWS Lambda container can then take the kernel's fast path at boot
  // instead of running its own `npm install` in an offline environment.
  const teloBin = resolve(REPO_ROOT, "cli/nodejs/bin/telo.mjs");
  execFileSync("node", [teloBin, "install", "./telo.yaml"], {
    cwd: dir,
    stdio: ["ignore", "ignore", "inherit"],
  });

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
