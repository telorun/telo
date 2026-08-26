// Who owns a package's version — the single answer, shared by every release script.
//
// A MODULE-OWNED package is one under `modules/`: its version is its MODULE's,
// written by `telo release apply` into `telo.yaml`, `package.json` and `Cargo.toml`
// together, and it is on `.changeset/config.json`'s `ignore` list so `changeset
// version` leaves it alone. Everything else is on the changesets ledger.
//
// Three scripts asked this question and answered it three ways — two duplicated the
// path rule verbatim, and the third (which DELETES GitHub Releases) resolved it by
// guessing that an npm name's suffix is a module directory name. One reader now,
// because the consequences differ per caller and a drifting rule would show up as a
// wrong deletion rather than as a failure.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MODULES = join(ROOT, "modules") + "/";

/** The workspace, read once: every package with its directory, version and privacy. */
export function loadWorkspace() {
  const listed = JSON.parse(
    execSync("pnpm -r list --depth -1 --json", { cwd: ROOT, encoding: "utf8", maxBuffer: 1e8 }),
  );
  const packages = listed
    .filter((pkg) => pkg.name && pkg.path)
    .map((pkg) => ({
      name: pkg.name,
      dir: resolve(pkg.path),
      version: pkg.version,
      private: pkg.private === true,
    }));

  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));

  /** A package whose version a module owns. Unknown names are NOT module-owned —
   *  see moduleDirectoryFor for the one caller that must also judge names the
   *  workspace no longer holds. */
  const isModuleOwned = (name) => {
    const pkg = byName.get(name);
    return pkg !== undefined && pkg.dir.startsWith(MODULES);
  };

  /** Published, non-module packages — the ones that legitimately carry a GitHub
   *  Release and an npm version of their own. */
  const releasing = new Set(
    packages.filter((pkg) => !pkg.private && !pkg.dir.startsWith(MODULES)).map((pkg) => pkg.name),
  );

  return {
    packages,
    dirOf: (name) => byName.get(name)?.dir,
    has: (name) => byName.has(name),
    isModuleOwned,
    releasing,
  };
}

/**
 * Whether `@telorun/<x>` names a module DIRECTORY that still exists — the only way
 * to judge a package the workspace no longer holds, which the release-pruning
 * script needs because the naming changed eras: before controllers were bundled a
 * module published `@telorun/<module>`, and now it is a private
 * `@telorun/<module>-build`, so a historical release names a package that is gone.
 *
 * It requires the directory to hold a `telo.yaml`, so this is "a module lives
 * here", not "a directory happens to share this name". Callers must still check
 * `releasing` FIRST: a package the workspace publishes today is never judged by
 * this, whatever directories exist beside it.
 */
export function moduleDirectoryFor(name) {
  const suffix = name.startsWith("@telorun/") ? name.slice("@telorun/".length) : null;
  if (!suffix || suffix.includes("/")) return false;
  return existsSync(join(ROOT, "modules", suffix, "telo.yaml"));
}
