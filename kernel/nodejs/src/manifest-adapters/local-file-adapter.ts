import { DEFAULT_MANIFEST_FILENAME, type ManifestAdapter } from "@telorun/analyzer";
import * as fs from "fs/promises";
import * as path from "path";

export class LocalFileAdapter implements ManifestAdapter {
  supports(pathOrUrl: string): boolean {
    return (
      pathOrUrl.startsWith("file://") ||
      pathOrUrl.startsWith("/") ||
      pathOrUrl.startsWith("./") ||
      pathOrUrl.startsWith("../") ||
      (!pathOrUrl.includes("://") && !pathOrUrl.includes("@"))
    );
  }

  async read(pathOrUrl: string): Promise<{ text: string; source: string }> {
    const normalizedPath = pathOrUrl.startsWith("file://")
      ? new URL(pathOrUrl).pathname
      : pathOrUrl;
    const resolvedPath = path.resolve(normalizedPath);
    const stat = await fs.stat(resolvedPath);
    const filePath = stat.isDirectory() ? path.join(resolvedPath, DEFAULT_MANIFEST_FILENAME) : resolvedPath;
    const text = await fs.readFile(filePath, "utf-8");
    return { text, source: `file://${filePath}` };
  }

  async readAll(pathOrUrl: string): Promise<string[]> {
    const normalizedPath = pathOrUrl.startsWith("file://")
      ? new URL(pathOrUrl).pathname
      : pathOrUrl;
    const resolvedPath = path.resolve(normalizedPath);
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      return this.collectYamlSources(resolvedPath);
    }
    return [`file://${resolvedPath}`];
  }

  resolveRelative(base: string, relative: string): string {
    const basePath = base.startsWith("file://") ? new URL(base).pathname : base;
    const baseDir = basePath.endsWith("/") ? basePath : path.dirname(basePath);
    return `file://${path.resolve(baseDir, relative)}`;
  }

  private async collectYamlSources(dirPath: string): Promise<string[]> {
    const sources: string[] = [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        sources.push(...(await this.collectYamlSources(fullPath)));
      } else if (entry.isFile() && this.isYamlFile(entry.name)) {
        sources.push(`file://${fullPath}`);
      }
    }
    return sources;
  }

  private isYamlFile(filename: string): boolean {
    return filename.endsWith(".yaml") || filename.endsWith(".yml");
  }
}
