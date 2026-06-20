import { extract as tarExtract, pack as tarPack } from "tar-stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { Readable } from "node:stream";

export interface BundleEntry {
  /** POSIX-relative path inside the archive (e.g. `telo.yaml`, `public/app.js`). */
  name: string;
  content: Buffer | string;
}

/**
 * Pack `entries` into a gzipped tar (`module.tar.gz`). The CLI's own writer —
 * deliberately not the runner's `apps/k8s-runner/src/tar.ts`, which is coupled
 * to `@telorun/runner-core`'s `RunBundle`. Artifacts are small (a manifest plus
 * a built frontend), so buffering the whole archive before gzip is fine.
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
      pack.entry({ name: entry.name }, buf, (err) => (err ? reject(err) : resolve()));
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
