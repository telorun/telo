import { ControllerInstance, RuntimeError } from "@telorun/sdk";
import { execFile } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import { PackageURL } from "packageurl-js";
import * as path from "path";
import { promisify } from "util";

const homedir = os.homedir();
const cacheRoot = process.env.TELO_CACHE_DIR
  ? path.resolve(process.env.TELO_CACHE_DIR)
  : path.join(homedir, ".cache", "telo");
const npmCacheRoot = path.join(cacheRoot, "npm");
const isBun = typeof (globalThis as any).Bun !== "undefined";

export class ControllerLoader {
  /**
   * Load controller instance from URI in format:
   *
   * <runtime>:<registry>:<path>@<version-spec>
   */
  async load(purlCandidates: string[], baseUri: string): Promise<ControllerInstance> {
    if (!purlCandidates || purlCandidates.length === 0) {
      throw new RuntimeError("ERR_CONTROLLER_NOT_FOUND", "Missing controller PURL candidates");
    }
    const purl = purlCandidates.find((p) => p.startsWith("pkg:npm"));
    if (!purl) {
      throw new RuntimeError(
        "ERR_CONTROLLER_NOT_FOUND",
        "Controller PURL candidates not applicable",
      );
    }
    const [type, namespace, name, versionSpec, qualifiers, entry] = PackageURL.parseString(purl);

    const localPath = (qualifiers as any)?.get("local_path");
    const cacheKey = createHash("sha256").update(purlCandidates[0]).digest("hex").slice(0, 12);
    const installDir = path.join(npmCacheRoot, cacheKey);

    let packageRoot: string;
    const isLocalManifest =
      baseUri && !baseUri.startsWith("http://") && !baseUri.startsWith("https://");
    if (localPath && isLocalManifest) {
      const baseUriPath = baseUri.startsWith("file://") ? baseUri.slice("file://".length) : baseUri;
      const manifestDir = path.dirname(baseUriPath);
      const resolvedLocalPath = path.resolve(manifestDir, localPath);
      if (await this.pathExists(resolvedLocalPath)) {
        packageRoot = resolvedLocalPath;
      } else {
        const nodeModulesPath = await this.findInNodeModules(`${namespace}/${name}`);
        if (nodeModulesPath) {
          packageRoot = nodeModulesPath;
        } else {
          await this.ensureNpmPackageInstalled(installDir, `${namespace}/${name}@${versionSpec}`);
          packageRoot = this.getInstalledPackageRoot(installDir, `${namespace}/${name}`);
        }
      }
    } else {
      const nodeModulesPath = await this.findInNodeModules(`${namespace}/${name}`);
      if (nodeModulesPath) {
        packageRoot = nodeModulesPath;
      } else {
        await this.ensureNpmPackageInstalled(installDir, `${namespace}/${name}@${versionSpec}`);
        packageRoot = this.getInstalledPackageRoot(installDir, `${namespace}/${name}`);
      }
    }

    const entryFile = await this.resolvePackageEntry(packageRoot, entry ? `./${entry}` : ".");
    const instance = await import(entryFile);
    if (!instance || (!instance.create && !instance.register)) {
      throw new Error(
        `Invalid controller loaded from "${purlCandidates[0]}": missing create or register function`,
      );
    }
    return instance;
  }

  private async ensureNpmPackageInstalled(installDir: string, packageSpec: string): Promise<void> {
    const packageName = this.getPackageName(
      packageSpec.startsWith(".") || path.isAbsolute(packageSpec)
        ? await this.getLocalPackageName(packageSpec)
        : packageSpec,
    );
    const packageRoot = this.getInstalledPackageRoot(installDir, packageName);
    const packageJsonPath = path.join(packageRoot, "package.json");
    if (await this.pathExists(packageJsonPath)) {
      return;
    }

    await fs.mkdir(installDir, { recursive: true });
    const rootPackageJson = path.join(installDir, "package.json");
    if (!(await this.pathExists(rootPackageJson))) {
      await fs.writeFile(
        rootPackageJson,
        JSON.stringify({ name: "telo-cache", private: true }, null, 2),
      );
    }

    const execFileAsync = promisify(execFile);
    const args = [
      "install",
      "--no-audit",
      "--no-fund",
      "--silent",
      "--prefix",
      installDir,
      packageSpec,
    ];

    await execFileAsync("npm", args);
  }

  private getPackageName(packageSpec: string): string {
    if (packageSpec.startsWith("@")) {
      const lastAt = packageSpec.lastIndexOf("@");
      return lastAt > 0 ? packageSpec.slice(0, lastAt) : packageSpec;
    }
    const [name] = packageSpec.split("@");
    return name;
  }

  private getInstalledPackageRoot(installDir: string, packageName: string): string {
    const nameParts = packageName.split("/");
    return path.join(installDir, "node_modules", ...nameParts);
  }

  private async getLocalPackageName(packagePath: string): Promise<string> {
    const packageJsonPath = path.join(packagePath, "package.json");
    if (!(await this.pathExists(packageJsonPath))) {
      throw new Error(`Local package missing package.json: ${packagePath}`);
    }
    const content = await fs.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed?.name) {
      throw new Error(`Local package missing name in package.json: ${packagePath}`);
    }
    return parsed.name;
  }

  private async resolvePackageEntry(
    packageRoot: string,
    entry: string,
    packageName?: string,
  ): Promise<string> {
    const packageJsonPath = path.join(packageRoot, "package.json");
    let resolvedPackageName = packageName;
    let packageJson: any = null;
    if (!resolvedPackageName && (await this.pathExists(packageJsonPath))) {
      const content = await fs.readFile(packageJsonPath, "utf8");
      try {
        packageJson = JSON.parse(content);
        resolvedPackageName = packageJson?.name;
      } catch {
        resolvedPackageName = packageName;
      }
    } else if (await this.pathExists(packageJsonPath)) {
      try {
        packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
      } catch {
        packageJson = null;
      }
    }

    const entryValue = entry.trim();
    const exportTarget = this.resolvePackageExportTarget(packageJson?.exports, entryValue);
    if (exportTarget) {
      const resolved = path.resolve(packageRoot, exportTarget);
      if (await this.pathExists(resolved)) {
        return this.resolveForRuntime(resolved, packageRoot);
      }
      if (!path.extname(resolved)) {
        const withJs = `${resolved}.js`;
        if (await this.pathExists(withJs)) {
          return withJs;
        }
      }
    }
    if ((entryValue === "." || entryValue === "./") && packageJson) {
      const mainFields = ["module", "main"];
      for (const field of mainFields) {
        const target = packageJson[field];
        if (typeof target === "string") {
          const resolved = path.resolve(packageRoot, target);
          if (await this.pathExists(resolved)) {
            return this.resolveForRuntime(resolved, packageRoot);
          }
          if (!path.extname(resolved)) {
            const withJs = `${resolved}.js`;
            if (await this.pathExists(withJs)) {
              return withJs;
            }
          }
        }
      }
    }

    const directPath = path.resolve(packageRoot, entryValue);
    if (await this.pathExists(directPath)) {
      return this.resolveForRuntime(directPath, packageRoot);
    }
    if (!path.extname(directPath)) {
      const withJs = `${directPath}.js`;
      if (await this.pathExists(withJs)) {
        return withJs;
      }
    }

    throw new Error(`Controller entry "${entryValue}" could not be resolved in ${packageRoot}`);
  }

  private resolvePackageExportTarget(exportsField: any, entry: string): string | null {
    if (!exportsField) {
      return null;
    }

    const key = entry === "." || entry === "./" ? "." : entry;
    const target = exportsField[key];
    return this.resolveExportTargetValue(target);
  }

  private resolveExportTargetValue(target: any): string | null {
    if (!target) {
      return null;
    }
    if (typeof target === "string") {
      return target;
    }
    if (Array.isArray(target)) {
      for (const item of target) {
        const resolved = this.resolveExportTargetValue(item);
        if (resolved) {
          return resolved;
        }
      }
      return null;
    }
    if (typeof target === "object") {
      const preferredKeys = isBun
        ? ["bun", "import", "default", "require"]
        : ["import", "default", "require"];
      for (const key of preferredKeys) {
        if (target[key]) {
          const resolved = this.resolveExportTargetValue(target[key]);
          if (resolved) {
            return resolved;
          }
        }
      }
    }
    return null;
  }

  /**
   * For Node.js, resolve .ts paths to their compiled .js equivalents in dist/.
   * Bun can load .ts directly, so it returns the path unchanged.
   */
  private async resolveForRuntime(resolvedPath: string, packageRoot: string): Promise<string> {
    if (isBun || !resolvedPath.endsWith(".ts")) {
      return resolvedPath;
    }
    // Try dist/ equivalent: src/foo.ts -> dist/foo.js
    const relative = path.relative(packageRoot, resolvedPath);
    const distEquivalent = path.resolve(
      packageRoot,
      relative.replace(/^src\//, "dist/").replace(/\.ts$/, ".js"),
    );
    if (await this.pathExists(distEquivalent)) {
      return distEquivalent;
    }
    // Fallback: same location but .js
    const jsPath = resolvedPath.replace(/\.ts$/, ".js");
    if (await this.pathExists(jsPath)) {
      return jsPath;
    }
    return resolvedPath;
  }

  private async findInNodeModules(packageName: string): Promise<string | null> {
    const nameParts = packageName.split("/");
    const candidates = [
      path.join(process.cwd(), "node_modules", ...nameParts),
      path.join(process.cwd(), "node_modules", ".pnpm", "node_modules", ...nameParts),
    ];
    for (const candidate of candidates) {
      const packageJsonPath = path.join(candidate, "package.json");
      if (await this.pathExists(packageJsonPath)) {
        return candidate;
      }
    }
    return null;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
