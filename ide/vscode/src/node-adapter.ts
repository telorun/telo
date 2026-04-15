import { DEFAULT_MANIFEST_FILENAME, type ManifestAdapter } from "@telorun/analyzer";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { minimatch } from "minimatch";

function toFilePath(url: string): string {
  return url.startsWith("file://") ? fileURLToPath(url) : url;
}

/** Node.js fs-based ManifestAdapter for local files. */
export class NodeAdapter implements ManifestAdapter {
  constructor(private readonly cwd: string = process.cwd()) {}

  supports(url: string): boolean {
    return (
      url.startsWith("file://") ||
      url.startsWith("/") ||
      url.startsWith("./") ||
      url.startsWith("../") ||
      (!url.includes("://") && !url.includes("@"))
    );
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const filePath = toFilePath(url);
    const stat = await fs.stat(filePath).catch(() => null);
    const resolvedPath =
      stat?.isDirectory() ? path.join(filePath, DEFAULT_MANIFEST_FILENAME) : filePath;
    const text = await fs.readFile(resolvedPath, "utf8");
    return { text, source: resolvedPath };
  }

  resolveRelative(base: string, relative: string): string {
    const baseDir = path.dirname(path.resolve(this.cwd, toFilePath(base)));
    return path.resolve(baseDir, relative);
  }

  async expandGlob(base: string, patterns: string[]): Promise<string[]> {
    const baseDir = path.dirname(path.resolve(this.cwd, toFilePath(base)));
    const entries = await fs.readdir(baseDir, { recursive: true, withFileTypes: true });
    const normalizedPatterns = patterns.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));
    const matched: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const relative = path.relative(baseDir, path.join(entry.parentPath, entry.name));
      const normalized = relative.replace(/\\/g, "/");
      if (normalizedPatterns.some((p) => minimatch(normalized, p))) {
        matched.push(path.resolve(baseDir, relative));
      }
    }
    return matched.sort();
  }

  async resolveOwnerOf(fileUrl: string): Promise<string | null> {
    const resolved = path.resolve(this.cwd, toFilePath(fileUrl));
    let dir = path.dirname(resolved);

    while (true) {
      const candidate = path.join(dir, DEFAULT_MANIFEST_FILENAME);
      if (candidate !== resolved) {
        try {
          await fs.access(candidate);
          return candidate;
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
}
