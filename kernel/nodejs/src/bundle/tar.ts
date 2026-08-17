import { extract as tarExtract, pack as tarPack } from "tar-stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { Readable } from "node:stream";

import type { PayloadFile } from "./files-integrity.js";

export interface BundleEntry {
  /** POSIX-relative path inside the archive (e.g. `telo.yaml`, `public/app.js`). */
  name: string;
  content: Buffer | string;
}

/** Normalize decoded tar entries to `PayloadFile`s (Buffer-backed content) —
 *  the fixed step both transports run after `readTarGz`. */
export function toPayloadFiles(entries: BundleEntry[]): PayloadFile[] {
  return entries.map((e) => ({
    name: e.name,
    content: typeof e.content === "string" ? Buffer.from(e.content) : e.content,
  }));
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
 */
const FIXED_HEADER = {
  mtime: new Date(0),
  mode: 0o644,
  uid: 0,
  gid: 0,
  uname: "",
  gname: "",
} as const;

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
export async function makeTarGz(entries: BundleEntry[]): Promise<Buffer> {
  const pack = tarPack();
  const chunks: Buffer[] = [];
  pack.on("data", (c: Buffer) => chunks.push(c));

  const done = new Promise<void>((resolve, reject) => {
    pack.on("end", resolve);
    pack.on("error", reject);
  });

  for (const entry of entries) {
    const buf = typeof entry.content === "string" ? Buffer.from(entry.content, "utf-8") : entry.content;
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: entry.name, ...FIXED_HEADER }, buf, (err) => (err ? reject(err) : resolve()));
    });
  }
  pack.finalize();
  await done;

  return gzipSync(Buffer.concat(chunks));
}

/** Decompress + untar a `module.tar.gz` buffer into its file entries. */
export async function readTarGz(buf: Buffer): Promise<BundleEntry[]> {
  const tar = gunzipSync(buf);
  const ex = tarExtract();
  const entries: BundleEntry[] = [];

  await new Promise<void>((resolve, reject) => {
    ex.on("entry", (header, stream, next) => {
      if (header.type !== "file") {
        stream.on("end", next);
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        entries.push({ name: header.name, content: Buffer.concat(chunks) });
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
