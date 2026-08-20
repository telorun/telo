import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeVersionSkew,
  ownedNpmPackages,
} from "../src/release/npm-controller-package.js";

/**
 * A module whose controller ships from npm must push that tarball with the
 * manifest that names it. Nothing did, which is how a module came to name a
 * version of itself npm had never seen.
 */
const dirs: string[] = [];

function moduleDir(pkg: Record<string, unknown> | undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-npm-pkg-"));
  dirs.push(dir);
  if (pkg) {
    fs.mkdirSync(path.join(dir, "nodejs"));
    fs.writeFileSync(path.join(dir, "nodejs", "package.json"), JSON.stringify(pkg));
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ownedNpmPackages", () => {
  // Candidates arrive already parsed by the caller's PURL parser — the same one
  // the loader uses — so this never re-derives the grammar.
  const own = { type: "npm", packageName: "@telorun/sqlite", versionSpec: "0.1.0" };
  const candidates = [own];

  it("finds the package the module itself provides", () => {
    const dir = moduleDir({ name: "@telorun/sqlite", version: "0.1.0" });
    expect(ownedNpmPackages(candidates, dir)).toEqual([
      {
        name: "@telorun/sqlite",
        pinnedVersion: "0.1.0",
        packageVersion: "0.1.0",
        directory: path.join(dir, "nodejs"),
      },
    ]);
  });

  it("ignores a PURL naming someone else's package", () => {
    const dir = moduleDir({ name: "@telorun/sqlite", version: "0.1.0" });
    expect(
      ownedNpmPackages([{ type: "npm", packageName: "left-pad", versionSpec: "1.0.0" }], dir),
    ).toEqual([]);
  });

  it("ignores a candidate delivered by another ecosystem", () => {
    const dir = moduleDir({ name: "@telorun/sqlite", version: "0.1.0" });
    // A `pkg:cargo` candidate whose crate happens to share the name is not an
    // npm tarball and is not this step's to push.
    expect(
      ownedNpmPackages(
        [{ type: "cargo", packageName: "@telorun/sqlite", versionSpec: "0.1.0" }],
        dir,
      ),
    ).toEqual([]);
  });

  it("ignores a private package — it is never published", () => {
    const dir = moduleDir({ name: "@telorun/sqlite", version: "0.1.0", private: true });
    expect(ownedNpmPackages(candidates, dir)).toEqual([]);
  });

  it("ignores a module with no package of its own", () => {
    expect(ownedNpmPackages(candidates, moduleDir(undefined))).toEqual([]);
  });

  it("reports one entry however many kinds name the same candidate", () => {
    const dir = moduleDir({ name: "@telorun/sqlite", version: "0.1.0" });
    expect(ownedNpmPackages([own, { ...own }], dir)).toHaveLength(1);
  });
});

describe("describeVersionSkew", () => {
  const owned = {
    name: "@telorun/sqlite",
    pinnedVersion: "0.1.0",
    packageVersion: "0.1.0",
    directory: "/x",
  };

  it("passes when the manifest, the package and the module agree", () => {
    expect(describeVersionSkew(owned, "0.1.0")).toBeUndefined();
  });

  it("catches a manifest pinning a version the package has moved past", () => {
    // Exactly the drift that left the old module naming a years-old tarball.
    expect(describeVersionSkew({ ...owned, packageVersion: "0.7.3" }, "0.7.3")).toMatch(
      /pins 0\.1\.0 but the package is 0\.7\.3/,
    );
  });

  it("catches a package that disagrees with its module", () => {
    expect(describeVersionSkew(owned, "0.2.0")).toMatch(/package is 0\.1\.0 but the module is 0\.2\.0/);
  });
});
