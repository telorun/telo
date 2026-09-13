import { extract as tarExtract, pack as tarPack } from "tar-stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { Readable } from "node:stream";

import type { PayloadFile } from "./files-integrity.js";

export type BundleEntry =
  | {
      /** POSIX-relative path inside the archive (e.g. `telo.yaml`, `public/app.js`). */
      name: string;
      content: Buffer | Uint8Array | string;
      executable?: boolean;
    }
  | {
      name: string;
      /** A symbolic link's target, exactly as the link stores it. */
      link: string;
    };

/** Normalize decoded tar entries to `PayloadFile`s (Buffer-backed content) —
 *  the fixed step both transports run after `readTarGz`. */
export function toPayloadFiles(entries: BundleEntry[]): PayloadFile[] {
  return entries.map((e) => {
    if ("link" in e) return { name: e.name, link: e.link };
    const content = typeof e.content === "string" ? Buffer.from(e.content) : e.content;
    return e.executable ? { name: e.name, content, executable: true } : { name: e.name, content };
  });
}

/**
 * Every tar header field that is not the file's own name or contents, pinned.
 *
 * **The archive has to be a pure function of the files in it**, because a
 * layer's `blob` digest covers these bytes and that digest is written into the
 * published `telo.yaml` — which a dependent hashes to derive its import pin,
 * before anything is pushed. A header carrying the wall clock (tar-stream
 * defaults `mtime` to `new Date()`) makes the same file set frame to different
 * bytes on every run, so the predicted digest and the pushed one would agree
 * only by accident.
 *
 * Reproducibility is the same property seen from outside: re-running publish on
 * one commit produces byte-identical layers. Node's gzip already writes no
 * timestamp, so the tar header is the whole of it.
 *
 * An executable file differs only in {@link EXECUTABLE_MODE}; a link is a
 * symlink entry carrying its target under the same fields.
 */
const FIXED_HEADER = {
  mtime: new Date(0),
  mode: 0o644,
  uid: 0,
  gid: 0,
  uname: "",
  gname: "",
} as const;

const EXECUTABLE_MODE = 0o755;

/**
 * Pack `entries` into a gzipped tar (`module.tar.gz`) — the module-artifact
 * writer shared by `telo publish` and the transports. Artifacts are small (a
 * manifest plus a built frontend), so buffering the whole archive before gzip
 * is fine. (Distinct from `apps/k8s-runner/src/tar.ts`, which is coupled to
 * `@telorun/runner-core`'s `RunBundle`.)
 *
 * Deterministic: identical entries in identical order produce identical bytes
 * (see {@link FIXED_HEADER}).
 */
export async function makeTarGz(entries: readonly BundleEntry[]): Promise<Buffer> {
  const pack = tarPack();
  const chunks: Buffer[] = [];
  pack.on("data", (c: Buffer) => chunks.push(c));

  const done = new Promise<void>((resolve, reject) => {
    pack.on("end", resolve);
    pack.on("error", reject);
  });

  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      const callback = (err?: Error | null) => (err ? reject(err) : resolve());
      if ("link" in entry) {
        pack.entry(
          { name: entry.name, type: "symlink", linkname: entry.link, ...FIXED_HEADER },
          callback,
        );
        return;
      }
      const buf =
        typeof entry.content === "string"
          ? Buffer.from(entry.content, "utf-8")
          : Buffer.isBuffer(entry.content)
            ? entry.content
            : Buffer.from(entry.content);
      const header = entry.executable
        ? { name: entry.name, ...FIXED_HEADER, mode: EXECUTABLE_MODE }
        : { name: entry.name, ...FIXED_HEADER };
      pack.entry(header, buf, callback);
    });
  }
  pack.finalize();
  await done;

  return gzipSync(Buffer.concat(chunks));
}

/** Decompress + untar a `module.tar.gz` buffer into its file and symbolic-link
 *  entries; any other entry type is skipped. `maxBytes` bounds the decompressed
 *  size, for an archive whose origin is not trusted to be small. */
export async function readTarGz(
  buf: Buffer,
  options: { maxBytes?: number } = {},
): Promise<BundleEntry[]> {
  let tar: Buffer;
  try {
    tar = gunzipSync(buf, options.maxBytes === undefined ? {} : { maxOutputLength: options.maxBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`it decompresses to more than the ${options.maxBytes}-byte limit`);
    }
    throw err;
  }
  const ex = tarExtract();
  const entries: BundleEntry[] = [];

  await new Promise<void>((resolve, reject) => {
    ex.on("entry", (header, stream, next) => {
      if (header.type === "symlink") {
        entries.push({ name: header.name, link: header.linkname ?? "" });
      }
      if (header.type !== "file") {
        stream.on("end", next);
        stream.resume();
        return;
      }
      const executable = ((header.mode ?? 0) & 0o111) !== 0;
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const content = Buffer.concat(chunks);
        entries.push(
          executable ? { name: header.name, content, executable: true } : { name: header.name, content },
        );
        next();
      });
      stream.on("error", reject);
    });
    ex.on("finish", resolve);
    ex.on("error", reject);
    Readable.from(tar).pipe(ex);
  });

  return entries;
}
