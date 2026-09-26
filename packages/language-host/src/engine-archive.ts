/**
 * Reading an engine out of its npm tarball with web globals only: WebCrypto
 * for the `sha512` integrity, `DecompressionStream` for gzip, and a minimal
 * ustar/pax reader for the two files an engine is — `package/package.json` and
 * `package/dist/language-server.mjs`.
 */

const ENGINE_FILE = "package/dist/language-server.mjs";
const MANIFEST_FILE = "package/package.json";

/** A download or a cached file that does not hash to what it must. */
export class EngineIntegrityError extends Error {}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** `sha512-<base64>`, npm's integrity form. */
export async function sha512Integrity(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", bytes as Uint8Array<ArrayBuffer>);
  return `sha512-${base64(new Uint8Array(digest))}`;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const decoder = new TextDecoder();

function field(block: Uint8Array, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return decoder.decode(end === -1 ? raw : raw.subarray(0, end));
}

function octal(block: Uint8Array, offset: number, length: number): number {
  const text = field(block, offset, length).trim();
  return text === "" ? 0 : parseInt(text, 8);
}

/** `path` records of a pax extended header (`<length> path=<value>\n`). */
function paxPath(body: Uint8Array): string | undefined {
  let path: string | undefined;
  for (const record of decoder.decode(body).split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match) path = match[1];
  }
  return path;
}

/** Regular files of a tar archive, by path. */
export function readTar(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156]!);
    const body = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "x") {
      longName = paxPath(body);
      continue;
    }
    if (type === "L") {
      longName = field(body, 0, body.length);
      continue;
    }
    if (type === "g") continue;
    const prefix = field(header, 257, 6).startsWith("ustar") ? field(header, 345, 155) : "";
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    if (type === "0" || type === "\0") files.set(name, body.slice());
  }
  return files;
}

/**
 * The engine inside a downloaded tarball, after the tarball has been verified
 * against `integrity`. Refuses a tarball that does not hash to it, one without
 * an engine file, and one whose own `package.json` does not declare a protocol
 * generation this host speaks — the registry document is not trusted for that.
 */
export async function extractEngine(
  version: string,
  tarball: Uint8Array,
  integrity: string,
  speaks: readonly number[],
): Promise<Uint8Array> {
  const actual = await sha512Integrity(tarball);
  if (actual !== integrity) {
    throw new EngineIntegrityError(
      `the downloaded telo ${version} engine does not match its published integrity ` +
        `(expected ${integrity}, got ${actual}); it was refused and not run.`,
    );
  }
  const files = readTar(await gunzip(tarball));
  const engine = files.get(ENGINE_FILE);
  const manifest = files.get(MANIFEST_FILE);
  if (!engine || !manifest) {
    throw new EngineIntegrityError(
      `the telo ${version} engine package carries no ${engine ? MANIFEST_FILE : ENGINE_FILE}.`,
    );
  }
  const generation = (JSON.parse(decoder.decode(manifest)) as { teloEditorProtocol?: unknown })
    .teloEditorProtocol;
  if (typeof generation !== "number" || !speaks.includes(generation)) {
    throw new EngineIntegrityError(
      `the telo ${version} engine declares teloEditorProtocol ${JSON.stringify(generation)}, ` +
        `which this editor does not speak (it speaks ${speaks.join(", ")}).`,
    );
  }
  return engine;
}
