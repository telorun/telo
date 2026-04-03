import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { BumpLevel, ControllerPublisher } from "./interface.js";

export const npmPublisher: ControllerPublisher = {
  type: "npm",

  async readVersion(localPath: string): Promise<string> {
    const pkgPath = path.join(localPath, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version: string };
    return pkg.version;
  },

  async bumpVersion(localPath: string, level: BumpLevel): Promise<string> {
    execSync(`npm version ${level} --no-git-tag-version --loglevel=error`, {
      cwd: localPath,
      stdio: "inherit",
    });
    return this.readVersion(localPath);
  },

  async build(localPath: string): Promise<void> {
    const result = spawnSync("npm", ["--loglevel=error", "run", "build"], {
      cwd: localPath,
      encoding: "utf-8",
    });
    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      throw new Error(`Build failed:\n${output}`);
    }
  },

  async publish(localPath: string, version: string): Promise<boolean> {
    const pkgPath = path.join(localPath, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name: string };
    const packageName = pkg.name;

    // Check if the version already exists on the registry
    try {
      execSync(`npm view ${packageName}@${version} version --loglevel=error`, {
        cwd: localPath,
        stdio: "pipe",
      });
      // If this succeeds, the version already exists — skip and signal caller
      return false;
    } catch {
      // npm view throws when the version is not found — proceed to publish
    }

    execSync("npm publish --access public --loglevel=error", { cwd: localPath, stdio: "inherit" });
    return true;
  },
};
