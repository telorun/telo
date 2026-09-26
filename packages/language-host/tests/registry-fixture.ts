/** A fake npm registry for one package: its document and tarballs, built with
 *  web globals only so the suite runs unchanged in both environments. */

import { sha512Integrity } from "../src/engine-archive.js";
import type { StoredCatalog } from "../src/version-catalog.js";

const encoder = new TextEncoder();

function header(name: string, size: number): Uint8Array {
  const block = new Uint8Array(512);
  const put = (text: string, offset: number) => block.set(encoder.encode(text), offset);
  put(name, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put("0", 156);
  put("ustar\0", 257);
  put("00", 263);
  const sum = block.reduce((a, b) => a + b, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

export function tar(files: Record<string, string | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? encoder.encode(content) : content;
    parts.push(header(name, bytes.length), bytes, new Uint8Array((512 - (bytes.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

/** The engine code a fake engine is recognised by in the test spawner, with
 *  how it misbehaves, if it does. */
export const engineCode = (version: string, behaviour?: string) =>
  `// fake engine ${version}${behaviour ? ` (${behaviour})` : ""}\n`;

export function readEngineCode(code: string): { version: string; behaviour?: string } | undefined {
  const match = /^\/\/ fake engine (\S+)(?: \((.*)\))?\n$/.exec(code);
  return match ? { version: match[1]!, ...(match[2] ? { behaviour: match[2] } : {}) } : undefined;
}

export async function engineTarball(version: string, protocol: unknown = 1, code = engineCode(version)) {
  const bytes = await gzip(
    tar({
      "package/package.json": JSON.stringify({ name: "@telorun/language-server", version, teloEditorProtocol: protocol }),
      "package/dist/language-server.mjs": code,
    }),
  );
  return { bytes, integrity: await sha512Integrity(bytes) };
}

/** A registry serving `versions` as offered engines (each with the engine code
 *  `code` gives it), plus whatever extra version metadata a test adds. `fetch`
 *  rejects everything when `offline`; the package document is answered only
 *  once `documentServed` resolves. */
export async function fakeRegistry(
  versions: string[],
  extra: Record<string, unknown> = {},
  code: (version: string) => string = (version) => engineCode(version),
): Promise<{
  fetch: typeof globalThis.fetch;
  offline: boolean;
  tarballs: Map<string, Uint8Array>;
  documentServed: Promise<void>;
  /** The catalog a host that read this registry has cached. */
  catalog: StoredCatalog;
}> {
  const tarballs = new Map<string, Uint8Array>();
  const document: { versions: Record<string, unknown> } = { versions: { ...extra } };
  for (const version of versions) {
    const { bytes, integrity } = await engineTarball(version, 1, code(version));
    const url = `https://registry.test/language-server-${version}.tgz`;
    tarballs.set(url, bytes);
    document.versions[version] = { teloEditorProtocol: 1, dist: { tarball: url, integrity } };
  }
  const catalog: StoredCatalog = {
    offered: versions.map((version) => ({ version, ...(document.versions[version] as any).dist })),
    unoffered: {},
  };
  const registry = {
    offline: false,
    tarballs,
    catalog,
    documentServed: Promise.resolve(),
    fetch: (async (input: string | URL | Request) => {
      if (registry.offline) throw new TypeError("fetch failed: network unreachable");
      const url = String(input);
      if (url === "https://registry.npmjs.org/@telorun/language-server") {
        await registry.documentServed;
        if (registry.offline) throw new TypeError("fetch failed: network unreachable");
        return new Response(JSON.stringify(document), { headers: { "content-type": "application/json" } });
      }
      const tarball = tarballs.get(url);
      return tarball ? new Response(tarball as Uint8Array<ArrayBuffer>) : new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch,
  };
  return registry;
}
