import type { ResourceInstance } from "@telorun/sdk";
import { readFile, writeFile } from "node:fs/promises";
import { FsManifest, requirePath, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";

interface FileEditInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

interface FileEditResult {
  replacements: number;
}

/** Byte offsets of every non-overlapping occurrence of `needle` in `haystack`. */
function findAll(haystack: Buffer, needle: Buffer): number[] {
  const positions: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    positions.push(at);
  }
  return positions;
}

class FileEditResource implements ResourceInstance<FileEditInput, FileEditResult> {
  constructor(private readonly base: string) {}

  async invoke(input: FileEditInput): Promise<FileEditResult> {
    const target = resolveTarget(this.base, requirePath("Fs.FileEdit", input?.path));
    if (typeof input?.oldString !== "string" || input.oldString.length === 0) {
      throw new Error("Fs.FileEdit: 'oldString' input is required and must be a non-empty string");
    }
    if (typeof input?.newString !== "string") {
      throw new Error("Fs.FileEdit: 'newString' input is required and must be a string");
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(target);
    } catch (err) {
      throw wrapFsError("Fs.FileEdit: cannot read", target, err);
    }

    // Operate on bytes, not decoded text: regions outside the match survive
    // byte-for-byte (comments, !cel tags, and any non-UTF-8 content), and the
    // literal search sidesteps regex / `$`-substitution.
    const oldBytes = Buffer.from(input.oldString, "utf8");
    const positions = findAll(buffer, oldBytes);
    const count = positions.length;
    if (count === 0) {
      throw new Error(`Fs.FileEdit: oldString not found in '${target}'`);
    }
    if (count > 1 && !input.replaceAll) {
      throw new Error(
        `Fs.FileEdit: oldString matches ${count} times in '${target}'; set 'replaceAll: true' or use a more specific string`,
      );
    }

    const newBytes = Buffer.from(input.newString, "utf8");
    const replacements = input.replaceAll ? count : 1;
    const parts: Buffer[] = [];
    let cursor = 0;
    for (let i = 0; i < replacements; i++) {
      const at = positions[i];
      parts.push(buffer.subarray(cursor, at), newBytes);
      cursor = at + oldBytes.length;
    }
    parts.push(buffer.subarray(cursor));

    try {
      await writeFile(target, Buffer.concat(parts));
    } catch (err) {
      throw wrapFsError("Fs.FileEdit: cannot write", target, err);
    }
    return { replacements };
  }
}

export function register(): void {}

export async function create(resource: FsManifest): Promise<FileEditResource> {
  return new FileEditResource(resolveBase(resource.cwd));
}
