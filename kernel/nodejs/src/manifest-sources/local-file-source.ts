import { DEFAULT_MANIFEST_FILENAME, type ManifestSource } from "@telorun/analyzer";
import { selectByPatterns } from "@telorun/glob";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

function toFilePath(pathOrUrl: string): string {
  return pathOrUrl.startsWith("file://") ? fileURLToPath(pathOrUrl) : pathOrUrl;
}

function toFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}

export class LocalFileSource implements ManifestSource {
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
    const rels: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      rels.push(path.relative(baseDir, path.join(entry.parentPath, entry.name)).replace(/\\/g, "/"));
    }
    // `include:` resolution may reach any co-located partial, so it opts out of
    // the soft default-ignore tier (parity with `telo publish`'s include path).
    // The hard tier (`node_modules`/`.git`/`.telo`) is always denied, so a broad
    // `**` include never recurses into the manifest cache.
    return selectByPatterns(rels, patterns, { applyDefaultIgnore: false }).map((rel) =>
      toFileUrl(path.resolve(baseDir, rel)),
    );
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
