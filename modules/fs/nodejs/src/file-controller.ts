import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { readFile } from "node:fs/promises";
import { FsManifest, requirePath, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";

interface FileInput {
  path: string;
  encoding?: "utf8" | "base64";
}

interface FileResult {
  content: string;
  size: number;
}

class FileResource implements ResourceInstance<FileInput, FileResult> {
  constructor(private readonly base: string) {}

  async invoke(input: FileInput): Promise<FileResult> {
    const target = resolveTarget(this.base, requirePath("Fs.File", input?.path));
    try {
      const buffer = await readFile(target);
      const content = input.encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf8");
      return { content, size: buffer.byteLength };
    } catch (err) {
      throw wrapFsError("Fs.File: cannot read", target, err);
    }
  }
}

export function register(): void {}

export async function create(resource: FsManifest): Promise<FileResource> {
  return new FileResource(resolveBase(resource.cwd));
}
