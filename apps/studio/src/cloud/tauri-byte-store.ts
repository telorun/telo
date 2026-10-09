import { DirectoryNotFoundError } from "../loader/adapters/directory-not-found";
import { FileNotFoundError, segmentsOf, type ByteStore } from "./byte-store";

/** The folder under the app's data directory every working copy lives in, one
 *  subdirectory per project id. */
const DATA_FOLDER = "cloud";

/**
 * A name as it is stored on disk. The shell's file scope does not let a
 * wildcard match a name starting with a dot, and a repository is full of them
 * (`.gitignore`, `.github/`), so a leading dot is written `%2E` — and `%`
 * itself `%25`, which keeps the mapping reversible.
 */
export function storedName(name: string): string {
  const escaped = name.replaceAll("%", "%25");
  return escaped.startsWith(".") ? `%2E${escaped.slice(1)}` : escaped;
}

export function repositoryName(stored: string): string {
  const dotted = stored.startsWith("%2E") ? `.${stored.slice(3)}` : stored;
  return dotted.replaceAll("%25", "%");
}

/** The desktop build's store: a folder under the app's data directory. */
export class TauriByteStore implements ByteStore {
  private root: Promise<string> | null = null;

  constructor(private readonly name: string) {}

  private async resolve(path: string): Promise<string> {
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    this.root ??= appDataDir().then((data) => join(data, DATA_FOLDER, this.name));
    return join(await this.root, ...segmentsOf(path).map(storedName));
  }

  async read(path: string): Promise<Uint8Array> {
    const { readFile, exists } = await import("@tauri-apps/plugin-fs");
    const target = await this.resolve(path);
    if (!(await exists(target))) throw new FileNotFoundError(path);
    return readFile(target);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const { writeFile, mkdir } = await import("@tauri-apps/plugin-fs");
    const segments = segmentsOf(path);
    await mkdir(await this.resolve(segments.slice(0, -1).join("/")), { recursive: true });
    await writeFile(await this.resolve(path), bytes);
  }

  async list(path: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
    const { readDir, exists, stat } = await import("@tauri-apps/plugin-fs");
    const target = await this.resolve(path);
    if (!(await exists(target)) || !(await stat(target)).isDirectory) {
      throw new DirectoryNotFoundError(path);
    }
    return (await readDir(target)).map((entry) => ({
      name: repositoryName(entry.name),
      isDirectory: entry.isDirectory,
    }));
  }

  async makeDirectory(path: string): Promise<void> {
    const { mkdir } = await import("@tauri-apps/plugin-fs");
    await mkdir(await this.resolve(path), { recursive: true });
  }

  async remove(path: string): Promise<void> {
    const { remove, exists } = await import("@tauri-apps/plugin-fs");
    const target = await this.resolve(path);
    if (await exists(target)) await remove(target, { recursive: true });
  }

  async exists(path: string): Promise<boolean> {
    const { exists } = await import("@tauri-apps/plugin-fs");
    return exists(await this.resolve(path));
  }
}
