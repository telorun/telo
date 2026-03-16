import * as fs from "fs/promises";
import * as path from "path";
import type { ManifestAdapter } from "../types.js";

/** Node.js fs-based ManifestAdapter for local files. Not browser-compatible. */
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
    const filePath = url.startsWith("file://") ? new URL(url).pathname : url;
    const stat = await fs.stat(filePath).catch(() => null);
    const resolvedPath =
      stat?.isDirectory() ? path.join(filePath, "module.yaml") : filePath;
    const text = await fs.readFile(resolvedPath, "utf8");
    return { text, source: resolvedPath };
  }

  resolveRelative(base: string, relative: string): string {
    const basePath = base.startsWith("file://") ? new URL(base).pathname : base;
    const baseDir = path.dirname(path.resolve(this.cwd, basePath));
    return path.resolve(baseDir, relative);
  }
}

/** @deprecated Use `new NodeAdapter(cwd)` instead */
export function createNodeAdapter(cwd: string = process.cwd()): ManifestAdapter {
  return new NodeAdapter(cwd);
}
