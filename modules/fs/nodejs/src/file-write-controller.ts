import type { ResourceInstance } from "@telorun/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FsManifest, requirePath, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";

interface FileWriteInput {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  createParents?: boolean;
}

interface FileWriteResult {
  bytesWritten: number;
}

class FileWriteResource implements ResourceInstance<FileWriteInput, FileWriteResult> {
  constructor(private readonly base: string) {}

  async invoke(input: FileWriteInput): Promise<FileWriteResult> {
    const target = resolveTarget(this.base, requirePath("Fs.FileWrite", input?.path));
    if (typeof input?.content !== "string") {
      throw new Error("Fs.FileWrite: 'content' input is required and must be a string");
    }
    const buffer = Buffer.from(input.content, input.encoding === "base64" ? "base64" : "utf8");
    try {
      if (input.createParents) await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buffer);
      return { bytesWritten: buffer.byteLength };
    } catch (err) {
      throw wrapFsError("Fs.FileWrite: cannot write", target, err);
    }
  }
}

export function register(): void {}

export async function create(resource: FsManifest): Promise<FileWriteResource> {
  return new FileWriteResource(resolveBase(resource.cwd));
}
