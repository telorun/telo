import { InvokeError, type Logger, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { FsManifest, requirePath, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";
import { assertTransferable, makeParents, placeNew, removeQuietly, withCleanup } from "./path-transfer.js";

interface CopyInput {
  path: string;
  destination: string;
}

interface CopyResult {
  copied: string;
  destination: string;
  files: number;
}

/** Walk the source and count its regular files, refusing any entry that is
 *  neither a file nor a directory (a link included). */
async function countFiles(entry: string): Promise<number> {
  const info = await lstat(entry);
  if (info.isFile()) return 1;
  if (!info.isDirectory()) {
    throw new InvokeError(
      "ERR_COPY_UNSUPPORTED_ENTRY",
      `Fs.Copy: '${entry}' is a ${info.isSymbolicLink() ? "symbolic link" : "special file"}; only files and directories are copied.`,
      { path: entry },
    );
  }
  let files = 0;
  for (const name of await readdir(entry)) files += await countFiles(path.join(entry, name));
  return files;
}

export type CopyFile = (from: string, to: string, mode: number) => Promise<void>;

/** Copy `source` to the absent `destination`, file by file. */
export async function copyTree(
  source: string,
  destination: string,
  copy: CopyFile = copyFile,
): Promise<void> {
  const info = await lstat(source);
  if (info.isDirectory()) {
    await mkdir(destination);
    for (const name of await readdir(source)) {
      await copyTree(path.join(source, name), path.join(destination, name), copy);
    }
    return;
  }
  await copy(source, destination, constants.COPYFILE_EXCL);
}

/** The all-or-nothing copy: built beside `destination`, renamed into place,
 *  removed with the parents it made when anything fails. */
export async function copyAtomically(
  source: string,
  destination: string,
  copy: CopyFile = copyFile,
): Promise<void> {
  let undoParents: () => Promise<void>;
  try {
    undoParents = await makeParents(destination);
  } catch (err) {
    throw wrapFsError("Fs.Copy: cannot create parents of", destination, err);
  }
  const staging = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomBytes(6).toString("hex")}.copying`,
  );
  try {
    await copyTree(source, staging, copy);
    await placeNew("Fs.Copy", staging, destination);
  } catch (err) {
    const failure = err instanceof InvokeError ? err : wrapFsError("Fs.Copy: cannot copy", source, err);
    throw await withCleanup(failure, () => removeQuietly(staging), undoParents);
  }
}

class CopyResource implements ResourceInstance<CopyInput, CopyResult> {
  constructor(
    private readonly base: string,
    private readonly log: Logger,
  ) {}

  async invoke(input: CopyInput): Promise<CopyResult> {
    const source = resolveTarget(this.base, requirePath("Fs.Copy", input?.path));
    const destination = resolveTarget(this.base, requirePath("Fs.Copy", input?.destination));
    await assertTransferable("Fs.Copy", source, destination, "ERR_COPY_INTO_ITSELF");

    let files: number;
    try {
      files = await countFiles(source);
    } catch (err) {
      if (err instanceof InvokeError) throw err;
      throw wrapFsError("Fs.Copy: cannot read", source, err);
    }
    await copyAtomically(source, destination);
    this.log.debug("Copied", { "file.path": source, "fs.destination": destination, "fs.files": files });
    return { copied: input.path, destination: input.destination, files };
  }
}

export function register(): void {}

export async function create(resource: FsManifest, ctx: ResourceContext): Promise<CopyResource> {
  return new CopyResource(resolveBase(resource.cwd), ctx.log);
}
