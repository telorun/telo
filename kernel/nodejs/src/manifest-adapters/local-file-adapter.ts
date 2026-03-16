import * as fs from "fs/promises";
import * as yaml from "js-yaml";
import * as path from "path";
import type { ManifestAdapter as AnalyzerAdapter } from "@telorun/analyzer";
import type { ManifestAdapter, ManifestSourceData } from "./manifest-adapter.js";

export class LocalFileAdapter implements ManifestAdapter, AnalyzerAdapter {
  supports(pathOrUrl: string): boolean {
    return (
      pathOrUrl.startsWith("file://") ||
      pathOrUrl.startsWith("/") ||
      pathOrUrl.startsWith("./") ||
      pathOrUrl.startsWith("../") ||
      (!pathOrUrl.includes("://") && !pathOrUrl.includes("@"))
    );
  }

  async read(pathOrUrl: string): Promise<ManifestSourceData> {
    const normalizedPath = pathOrUrl.startsWith("file://")
      ? pathOrUrl.slice("file://".length)
      : pathOrUrl;
    const stat = await fs.stat(normalizedPath);
    const filePath = stat.isDirectory() ? path.join(normalizedPath, "module.yaml") : normalizedPath;
    return this.readFile(filePath);
  }

  async readAll(pathOrUrl: string): Promise<ManifestSourceData[]> {
    const normalizedPath = pathOrUrl.startsWith("file://")
      ? pathOrUrl.slice("file://".length)
      : pathOrUrl;
    const stat = await fs.stat(normalizedPath);
    if (stat.isDirectory()) {
      const results: ManifestSourceData[] = [];
      await this.collectYamlFiles(normalizedPath, results);
      return results;
    }
    return [await this.readFile(normalizedPath)];
  }

  resolveRelative(base: string, relative: string): string {
    const basePath = base.startsWith("file://") ? base.slice("file://".length) : base;
    const baseDir = basePath.endsWith("/") ? basePath : path.dirname(basePath);
    return `file://${path.resolve(baseDir, relative)}`;
  }

  private async readFile(filePath: string): Promise<ManifestSourceData> {
    const content = await fs.readFile(filePath, "utf-8");
    return {
      text: content,
      documents: yaml.loadAll(content),
      source: `file://${filePath}`,
      baseDir: path.dirname(filePath),
      uriBase: `file://localhost${filePath.replace(/\\/g, "/")}`,
    };
  }

  private async collectYamlFiles(dirPath: string, results: ManifestSourceData[]): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await this.collectYamlFiles(fullPath, results);
      } else if (entry.isFile() && this.isYamlFile(entry.name)) {
        results.push(await this.readFile(fullPath));
      }
    }
  }

  private isYamlFile(filename: string): boolean {
    return filename.endsWith(".yaml") || filename.endsWith(".yml");
  }
}
