import type { ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { FsManifest, requirePath, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";

interface FileInput {
  path: string;
  encoding?: "utf8" | "base64";
  /** A computed bound arrives as an int64. */
  maxBytes?: number | bigint;
}

interface FileResult {
  content: string;
  size: number;
  sha256: string;
}

class FileResource implements ResourceInstance<FileInput, FileResult> {
  constructor(private readonly base: string) {}

  async invoke(input: FileInput): Promise<FileResult> {
    const target = resolveTarget(this.base, requirePath("Fs.File", input?.path));
    const maxBytes = input.maxBytes === undefined ? undefined : Number(input.maxBytes);
    let buffer: Buffer;
    try {
      const handle = await open(target, "r");
      try {
        // The size is asked of the open file, so a file over the bound is
        // refused before any of its content is read.
        if (maxBytes !== undefined) refuseOver(target, (await handle.stat()).size, maxBytes);
        buffer = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (err) {
      if (err instanceof InvokeError) throw err;
      throw wrapFsError("Fs.File: cannot read", target, err);
    }
    // A file that grew between the size check and the read is over the bound too.
    if (maxBytes !== undefined) refuseOver(target, buffer.byteLength, maxBytes);
    return {
      content: input.encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf8"),
      size: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
  }
}

function refuseOver(target: string, size: number, maxBytes: number): void {
  if (size <= maxBytes) return;
  throw new InvokeError(
    "ERR_FILE_TOO_LARGE",
    `Fs.File: '${target}' is ${size} bytes, over the ${maxBytes} bytes 'maxBytes' allows; it was not read.`,
    { path: target, size, maxBytes },
  );
}

export function register(): void {}

export async function create(resource: FsManifest): Promise<FileResource> {
  return new FileResource(resolveBase(resource.cwd));
}
