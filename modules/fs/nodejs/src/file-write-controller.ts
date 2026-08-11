import { SEVERITY, type Logger, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FsManifest,
  requirePath,
  resolveBase,
  resolveTarget,
  toWritableBytes,
  WritableContent,
  wrapFsError,
} from "./fs-support.js";

interface FileWriteInput {
  path: string;
  content: WritableContent;
  encoding?: "utf8" | "base64";
  createParents?: boolean;
}

interface FileWriteResult {
  bytesWritten: number;
}

class FileWriteResource implements ResourceInstance<FileWriteInput, FileWriteResult> {
  constructor(
    private readonly base: string,
    private readonly log: Logger,
  ) {}

  async invoke(input: FileWriteInput): Promise<FileWriteResult> {
    const target = resolveTarget(this.base, requirePath("Fs.FileWrite", input?.path));
    const buffer = toWritableBytes("Fs.FileWrite", input?.content, input?.encoding);
    try {
      if (input.createParents) await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buffer);
      // `debug`, not `info`: a write leaves the file behind to inspect, so the
      // record is a convenience rather than the only account — unlike a removal.
      // The content is never logged; only where it went and how much.
      if (this.log.enabled(SEVERITY.debug)) {
        this.log.debug("Wrote", { "file.path": target, "file.size": buffer.byteLength });
      }
      return { bytesWritten: buffer.byteLength };
    } catch (err) {
      throw wrapFsError("Fs.FileWrite: cannot write", target, err);
    }
  }
}

export function register(): void {}

export async function create(
  resource: FsManifest,
  ctx: ResourceContext,
): Promise<FileWriteResource> {
  return new FileWriteResource(resolveBase(resource.cwd), ctx.log);
}
