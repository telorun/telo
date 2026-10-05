import { DirectoryNotFoundError } from "../loader/adapters/directory-not-found";
import { FileNotFoundError, segmentsOf, type ByteStore } from "./byte-store";

/** The directory in the Origin Private File System every working copy lives
 *  under, one subdirectory per workspace id. */
const OPFS_ROOT = "telo-studio-cloud";

function isMissing(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotFoundError" || error.name === "TypeMismatchError")
  );
}

async function opfsRoot(create: boolean): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error("This browser has no private file system for a Telo Cloud working copy.");
  }
  const origin = await navigator.storage.getDirectory();
  return origin.getDirectoryHandle(OPFS_ROOT, { create });
}

/** The web build's store: a directory of the Origin Private File System. */
export class OpfsByteStore implements ByteStore {
  private root: Promise<FileSystemDirectoryHandle> | null = null;

  constructor(private readonly name: string) {}

  private rootHandle(): Promise<FileSystemDirectoryHandle> {
    this.root ??= opfsRoot(true).then((dir) => dir.getDirectoryHandle(this.name, { create: true }));
    return this.root;
  }

  private async directory(segments: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = await this.rootHandle();
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create });
    return dir;
  }

  async read(path: string): Promise<Uint8Array> {
    const segments = segmentsOf(path);
    try {
      const dir = await this.directory(segments.slice(0, -1), false);
      const file = await (await dir.getFileHandle(segments[segments.length - 1]!)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (isMissing(error)) throw new FileNotFoundError(path);
      throw error;
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const segments = segmentsOf(path);
    const dir = await this.directory(segments.slice(0, -1), true);
    const handle = await dir.getFileHandle(segments[segments.length - 1]!, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes as Uint8Array<ArrayBuffer>);
    await writable.close();
  }

  async list(path: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await this.directory(segmentsOf(path), false);
    } catch (error) {
      if (isMissing(error)) throw new DirectoryNotFoundError(path);
      throw error;
    }
    const entries: Array<{ name: string; isDirectory: boolean }> = [];
    for await (const [name, handle] of dir.entries()) {
      entries.push({ name, isDirectory: handle.kind === "directory" });
    }
    return entries;
  }

  async makeDirectory(path: string): Promise<void> {
    await this.directory(segmentsOf(path), true);
  }

  async remove(path: string): Promise<void> {
    const segments = segmentsOf(path);
    try {
      if (segments.length === 0) {
        this.root = null;
        await (await opfsRoot(false)).removeEntry(this.name, { recursive: true });
        return;
      }
      const dir = await this.directory(segments.slice(0, -1), false);
      await dir.removeEntry(segments[segments.length - 1]!, { recursive: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    const segments = segmentsOf(path);
    if (segments.length === 0) return true;
    try {
      const dir = await this.directory(segments.slice(0, -1), false);
      for await (const name of dir.keys()) {
        if (name === segments[segments.length - 1]) return true;
      }
      return false;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
}
