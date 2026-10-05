/**
 * Where a working copy keeps its bytes on the device: a tree of files addressed
 * by `/`-separated paths relative to the store's root (`""` is the root). The
 * web build keeps it in the browser's Origin Private File System, the desktop
 * build in a folder under the app's data directory; nothing above this
 * interface knows which.
 */
export interface ByteStore {
  /** Rejects with `FileNotFoundError` when the path names no file. */
  read(path: string): Promise<Uint8Array>;
  /** Creates parent directories as needed. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** One level. Rejects with `DirectoryNotFoundError` when the path names no
   *  directory. */
  list(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  makeDirectory(path: string): Promise<void>;
  /** A file, or a directory with everything beneath it. Removing what is not
   *  there is not an error. */
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export class FileNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`File not found: ${path}`);
    this.name = "FileNotFoundError";
  }
}

export function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Every file beneath `path`, as paths relative to it. An absent directory
 *  holds none. */
export async function listFilesRecursive(store: ByteStore, path: string): Promise<string[]> {
  if (!(await store.exists(path))) return [];
  const files: string[] = [];
  const walk = async (dir: string, relative: string) => {
    for (const entry of await store.list(dir)) {
      const child = dir ? `${dir}/${entry.name}` : entry.name;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory) await walk(child, childRelative);
      else files.push(childRelative);
    }
  };
  await walk(path, "");
  return files;
}
