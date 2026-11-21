// The Node half of the sweep's `load` dimension, run by `sweep.mjs` from the repo root:
// `bun .claude/skills/rust-parity/load-node.ts <entry manifest>`, under the workspace's `bun` from
// `node_modules/.bin`, which the sweep puts first on PATH. Loads the entry with the Node
// kernel's `analyzeOnly` option — the sources `telo run` reads through, no cache write — and
// prints the refusal, if any, as one JSON object on stdout, exiting 1:
// `{ code, message, carried: [{ code?, file?, path?, resource?, message, writtenAt? }] }` — each
// carried finding under the code it is raised as, `file` its origin's file (absent: the entry),
// `path` and `resource` its origin's field path and declaration (absent when it has none) and
// `writtenAt` the place its defect is written (absent for the reporting module's own). A load
// nothing refuses prints nothing and exits 0. The Rust half is `kernel/rust/examples/analyze_only.rs`.

import { dirname, join, resolve } from "node:path";
import { Kernel, LocalFileSource, LocalManifestCacheSource } from "../../../kernel/nodejs/src/index.ts";
import type { RuntimeDiagnostic } from "../../../kernel/nodejs/src/index.ts";
import { resolveCacheRoot } from "../../../kernel/nodejs/src/manifest-sources/local-manifest-cache-source.ts";

const [entry, ...rest] = process.argv.slice(2);
if (!entry || rest.length > 0) {
  process.stderr.write("usage: load-node.ts <entry manifest>\n");
  process.exit(2);
}

const cacheRoot = resolveCacheRoot(entry);
const kernel = new Kernel({
  sources: [
    new LocalFileSource(),
    ...(cacheRoot ? [new LocalManifestCacheSource(dirname(resolve(entry)), join(cacheRoot, "manifests"))] : []),
  ],
});
try {
  await kernel.load(entry, { analyzeOnly: true, writeCache: false });
} catch (err) {
  const { code, message, diagnostics } = err as { code?: string; message: string; diagnostics?: RuntimeDiagnostic[] };
  const carried = (diagnostics ?? []).map((d) => ({
    ...(d.code !== undefined ? { code: d.code } : {}),
    ...(d.origin?.filePath !== undefined ? { file: d.origin.filePath } : {}),
    ...(d.origin?.path !== undefined ? { path: d.origin.path } : {}),
    ...(d.origin?.resource !== undefined ? { resource: d.origin.resource } : {}),
    message: d.message,
    ...(d.origin?.writtenAt ? { writtenAt: d.origin.writtenAt } : {}),
  }));
  process.stdout.write(`${JSON.stringify({ code, message, carried })}\n`);
  process.exit(1);
}
process.exit(0);
