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
import { fileTooLarge, invalidContent, isByteStream, writeStream } from "./stream-file-write.js";

const KIND = "Fs.FileWrite";

interface FileWriteInput {
  path: string;
  content: WritableContent | AsyncIterable<unknown>;
  encoding?: "utf8" | "base64";
  createParents?: boolean;
  /** A computed bound arrives as an int64. */
  maxBytes?: number | bigint | null;
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
    const target = resolveTarget(this.base, requirePath(KIND, input?.path));
    const maxBytes =
      input.maxBytes === undefined || input.maxBytes === null ? undefined : Number(input.maxBytes);
    const bytesWritten = isByteStream(input.content)
      ? await writeStream({
          kind: KIND,
          target,
          source: input.content,
          maxBytes,
          createParents: input.createParents === true,
          log: this.log,
        })
      : await this.writeWhole(target, input, maxBytes);
    // `debug`, not `info`: a write leaves the file behind to inspect, so the
    // record is a convenience rather than the only account — unlike a removal.
    // The content is never logged; only where it went and how much.
    if (this.log.enabled(SEVERITY.debug)) {
      this.log.debug("Wrote", { "file.path": target, "file.size": bytesWritten });
    }
    return { bytesWritten };
  }

  /** Text and bytes are written in place; their size is known up front, so the
   *  bound is decided before the file is opened. */
  private async writeWhole(
    target: string,
    input: FileWriteInput,
    maxBytes: number | undefined,
  ): Promise<number> {
    // A stream is a live value the input contract never inspects, so with a
    // stream branch declared the contract admits any value here; the refusal
    // it would have made is made here, under its code.
    if (typeof input.content !== "string" && !(input.content instanceof Uint8Array)) {
      throw invalidContent(KIND, "must be text, raw bytes or a stream of bytes");
    }
    const buffer = toWritableBytes(KIND, input.content, input.encoding);
    if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
      throw fileTooLarge(KIND, target, maxBytes, buffer.byteLength);
    }
    try {
      if (input.createParents) await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buffer);
    } catch (err) {
      throw wrapFsError(`${KIND}: cannot write`, target, err);
    }
    return buffer.byteLength;
  }
}

export function register(): void {}

export async function create(
  resource: FsManifest,
  ctx: ResourceContext,
): Promise<FileWriteResource> {
  return new FileWriteResource(resolveBase(resource.cwd), ctx.log);
}
