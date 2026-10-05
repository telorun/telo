import { DirectoryNotFoundError } from "../../loader/adapters/directory-not-found";
import { FileNotFoundError, type ByteStore } from "../byte-store";

/** A byte store held in a map, for tests. */
export class MemoryByteStore implements ByteStore {
  readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>();

  async read(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new FileNotFoundError(path);
    return bytes;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes.slice());
  }

  async list(path: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
    const prefix = path ? `${path}/` : "";
    const entries = new Map<string, boolean>();
    for (const known of [...this.files.keys(), ...[...this.directories].map((d) => `${d}/`)]) {
      if (!known.startsWith(prefix)) continue;
      const rest = known.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) entries.set(rest, false);
      else entries.set(rest.slice(0, slash), true);
    }
    if (entries.size === 0 && path && !this.directories.has(path)) {
      throw new DirectoryNotFoundError(path);
    }
    return [...entries].map(([name, isDirectory]) => ({ name, isDirectory }));
  }

  async makeDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }

  async remove(path: string): Promise<void> {
    for (const known of [...this.files.keys()]) {
      if (path === "" || known === path || known.startsWith(`${path}/`)) this.files.delete(known);
    }
    for (const known of [...this.directories]) {
      if (path === "" || known === path || known.startsWith(`${path}/`)) this.directories.delete(known);
    }
  }

  async exists(path: string): Promise<boolean> {
    if (path === "" || this.files.has(path) || this.directories.has(path)) return true;
    return [...this.files.keys()].some((known) => known.startsWith(`${path}/`));
  }
}

export const bytes = (text: string) => new TextEncoder().encode(text);
export const text = (data: Uint8Array) => new TextDecoder().decode(data);
