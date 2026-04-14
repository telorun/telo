import { DEFAULT_MANIFEST_FILENAME, type ManifestAdapter } from "@telorun/analyzer";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { minimatch } from "minimatch";

function toFilePath(pathOrUrl: string): string {
  return pathOrUrl.startsWith("file://") ? fileURLToPath(pathOrUrl) : pathOrUrl;
}

function toFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}

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
    const resolvedPath = path.resolve(toFilePath(pathOrUrl));
    const stat = await fs.stat(resolvedPath);
    const filePath = stat.isDirectory() ? path.join(resolvedPath, DEFAULT_MANIFEST_FILENAME) : resolvedPath;
    const text = await fs.readFile(filePath, "utf-8");
    return { text, source: toFileUrl(filePath) };
  }

  async readAll(pathOrUrl: string): Promise<string[]> {
    const resolvedPath = path.resolve(toFilePath(pathOrUrl));
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      return this.collectYamlSources(resolvedPath);
    }
    return [toFileUrl(resolvedPath)];
  }

  resolveRelative(base: string, relative: string): string {
    const basePath = toFilePath(base);
    const baseDir = basePath.endsWith("/") ? basePath : path.dirname(basePath);
    return toFileUrl(path.resolve(baseDir, relative));
  }

  async expandGlob(base: string, patterns: string[]): Promise<string[]> {
    const baseDir = path.dirname(path.resolve(toFilePath(base)));
    const entries = await fs.readdir(baseDir, { recursive: true, withFileTypes: true });
    const normalizedPatterns = patterns.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));
    const matched: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const relative = path.relative(baseDir, path.join(entry.parentPath, entry.name));
      const normalized = relative.replace(/\\/g, "/");
      if (normalizedPatterns.some((p) => minimatch(normalized, p))) {
        matched.push(toFileUrl(path.resolve(baseDir, relative)));
      }
    }
    return matched.sort();
  }

  async resolveOwnerOf(fileUrl: string): Promise<string | null> {
    const resolved = path.resolve(toFilePath(fileUrl));
    let dir = path.dirname(resolved);

    while (true) {
      const candidate = path.join(dir, DEFAULT_MANIFEST_FILENAME);
      if (candidate !== resolved) {
        try {
          await fs.access(candidate);
          return toFileUrl(candidate);
        } catch {
          // telo.yaml not found at this level
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  private async collectYamlSources(dirPath: string): Promise<string[]> {
    const sources: string[] = [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        sources.push(...(await this.collectYamlSources(fullPath)));
      } else if (entry.isFile() && this.isYamlFile(entry.name)) {
        sources.push(toFileUrl(fullPath));
      }
    }
    return sources;
  }

  private isYamlFile(filename: string): boolean {
    return filename.endsWith(".yaml") || filename.endsWith(".yml");
  }
}
