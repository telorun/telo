// The Node half of the sweep's `load` dimension, run by `sweep.mjs` from the repo root:
// `bun .claude/skills/rust-parity/load-node.ts <entry manifest>`. Loads the entry with the Node
// kernel's `analyzeOnly` option — the sources `telo run` reads through, no cache write — and
// prints the refusal, if any, as `[<CODE>] <message>` and then each carried diagnostic as
// `  [<CODE>] <message>` (`  <message>` with no code), exiting 1; a load nothing refuses prints
// nothing and exits 0. The Rust half is `kernel/rust/examples/analyze_only.rs`.

import { dirname, join, resolve } from "node:path";
import { Kernel, LocalFileSource, LocalManifestCacheSource } from "../../../kernel/nodejs/src/index.ts";
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
  const { code, message, diagnostics } = err as {
    code?: string;
    message: string;
    diagnostics?: Array<{ code?: string; message: string }>;
  };
  const lines = [`[${code}] ${message}`];
  for (const d of diagnostics ?? []) lines.push(d.code ? `  [${d.code}] ${d.message}` : `  ${d.message}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(1);
}
process.exit(0);
