import { httpManifestUrl, splitIntegrity } from "@telorun/analyzer";
import { RuntimeError, fetchOrThrow } from "@telorun/sdk";
import { createHash, randomUUID } from "crypto";
import { createWriteStream, existsSync } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { pathToFileURL } from "url";

import { assertPublicEgress } from "./transports/egress-guard.js";

/** The largest file fetched from a plain URL, and how long one fetch may take. */
export const MAX_REMOTE_FILE_BYTES = 512 * 1024 * 1024;
export const REMOTE_FILE_TIMEOUT_MS = 5 * 60_000;

/** A module read from a plain `http(s)://` URL: where its manifest lives and
 *  the directory its files are kept in. */
export interface RemoteModule {
  /** The URL of the module's `telo.yaml`; files are located beside it. */
  readonly manifestUrl: string;
  /** Where fetched files are written, laid out as they are beside the manifest. */
  readonly directory: string;
  /** True when a file already in `directory` may be used without fetching it
   *  again: only when the import pins the manifest, since the directory is then
   *  keyed by that pin and a re-pin starts a new one. */
  readonly reuse: boolean;
  /** A directory that must be owned by this user and closed to others before
   *  anything is written beneath it — a scratch directory in a shared temp. */
  readonly privateRoot?: string;
}

/** The manifest URL a module requested as `ref` is read from, or `undefined`
 *  when `ref` is not an http(s) URL. */
export const remoteManifestUrl = httpManifestUrl;

/** The directory a pinned module's files are kept in, beside its manifest:
 *  keyed by the pin, so a changed manifest never finds the files of another. */
export function pinnedFilesDirectory(base: string, pinnedRef: string): string {
  const { integrity } = splitIntegrity(pinnedRef);
  return integrity ? path.join(base, `.files-${integrity.replace(/[^A-Za-z0-9_-]/g, "_")}`) : base;
}

/** A directory for a module with no cache root to live in: private to this
 *  user, keyed by the manifest URL. */
export function remoteModuleScratchDirectory(manifestUrl: string): { directory: string; root: string } {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const root = path.join(os.tmpdir(), `telo-remote-modules-${uid}`);
  const key = createHash("sha256").update(manifestUrl).digest("hex").slice(0, 16);
  return { root, directory: path.join(root, key) };
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isDirectory() || (owner !== undefined && (stat.uid !== owner || (stat.mode & 0o077) !== 0))) {
    throw new RuntimeError(
      "ERR_MODULE_FILES_UNAVAILABLE",
      `Refusing to keep module files in '${dir}': it must be a directory owned by this user that ` +
        `no one else can use. Remove it, or set TELO_CACHE_DIR to a directory of your own.`,
    );
  }
}

/**
 * The module files of modules read over plain HTTP: a module file is fetched
 * from beside its manifest URL on first use and kept on disk, so a claim on it
 * (`!module-path`, `!include-*`, `ctx.resolveModuleFile`) resolves to a local
 * file exactly as it does for a module with a payload artifact.
 *
 * A plain URL cannot be listed, so a claim names a file — never a directory —
 * and nothing verifies what the origin sends beyond the manifest's own pin.
 */
export class RemoteModuleFiles {
  private readonly modules = new Map<string, RemoteModule>();
  private readonly fetched = new Map<string, Promise<string>>();

  clear(): void {
    this.modules.clear();
    this.fetched.clear();
  }

  register(source: string, module: RemoteModule): void {
    this.modules.set(source, module);
  }

  has(source: string): boolean {
    return this.modules.has(source);
  }

  /** The `file://` URI of `relative` (module-root-relative, already confined) in
   *  the module whose manifest was read as `source`. */
  async resolve(source: string, relative: string): Promise<string> {
    const module = this.modules.get(source);
    if (!module) {
      throw new RuntimeError(
        "ERR_MODULE_FILES_UNAVAILABLE",
        `Cannot resolve '${relative}': '${source}' is not a module read over HTTP.`,
      );
    }
    const leaves = () =>
      new RuntimeError(
        "ERR_MODULE_FILES_UNAVAILABLE",
        `Cannot resolve '${relative}' against module '${module.manifestUrl}': the path leaves the module.`,
      );
    const directory = path.resolve(module.directory);
    const target = path.join(directory, relative);
    if (!target.startsWith(directory + path.sep)) throw leaves();
    // The URL is what is fetched: `%2e%2e` and a backslash are read by it as
    // parts of the path, which the local path above does not see.
    const url = new URL(relative, module.manifestUrl);
    if (!url.href.startsWith(new URL("./", module.manifestUrl).href)) throw leaves();

    let pending = this.fetched.get(target);
    if (!pending) {
      pending = this.materialize(module, directory, relative, url.href, target, leaves);
      this.fetched.set(target, pending);
      pending.catch(() => this.fetched.delete(target));
    }
    return pathToFileURL(await pending).href;
  }

  private async materialize(
    module: RemoteModule,
    directory: string,
    relative: string,
    url: string,
    target: string,
    leaves: () => RuntimeError,
  ): Promise<string> {
    if (module.privateRoot) await ensurePrivateDirectory(module.privateRoot);
    if (module.reuse && existsSync(target)) return target;

    await assertPublicEgress(url);
    const response = await fetchOrThrow(
      url,
      { signal: AbortSignal.timeout(REMOTE_FILE_TIMEOUT_MS) },
      { operation: "Module file read" },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new RuntimeError(
        "ERR_MODULE_FILES_UNAVAILABLE",
        `Cannot resolve '${relative}' against module '${module.manifestUrl}': ${url} returned ` +
          `${response.status} ${response.statusText}. A module read over HTTP serves its files ` +
          `from beside its telo.yaml, and a claim names a file, never a directory.`,
      );
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    // A link inside the module directory must not carry the write out of it.
    const root = await fs.realpath(directory);
    const parent = await fs.realpath(path.dirname(target));
    if (parent !== root && !parent.startsWith(root + path.sep)) throw leaves();

    const partial = `${target}.${randomUUID()}.partial`;
    let received = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > MAX_REMOTE_FILE_BYTES) {
          done(
            new RuntimeError(
              "ERR_MODULE_FILES_UNAVAILABLE",
              `Cannot resolve '${relative}' against module '${module.manifestUrl}': ${url} is larger ` +
                `than the ${MAX_REMOTE_FILE_BYTES} bytes a module file fetched over HTTP may be.`,
            ),
          );
          return;
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        cap,
        createWriteStream(partial, { flags: "wx" }),
      );
      await fs.rename(partial, target);
    } catch (error) {
      await fs.rm(partial, { force: true });
      throw error;
    }
    return target;
  }
}
