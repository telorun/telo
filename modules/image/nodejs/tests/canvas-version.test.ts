import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// The staged Skia addon and the wrapper a bundle inlines are one release: the
// addon path is process-wide, and a wrapper opening another release's addon
// ends the process. Both modules staging it are held to their own lockfile entry.
const modules = [
  { name: "image", manifest: "../../telo.yaml", pkg: "../package.json" },
  { name: "pdf", manifest: "../../../pdf/telo.yaml", pkg: "../../../pdf/nodejs/package.json" },
];

it.each(modules)("$name stages the @napi-rs/canvas release its wrapper resolves to", async (module) => {
  const manifest = await readFile(new URL(module.manifest, import.meta.url), "utf8");
  const staged = /^ {2}canvas:\n {4}version: (\S+)$/m.exec(manifest)?.[1];
  expect(staged, `${module.name}/telo.yaml declares sources.canvas.version`).toBeDefined();

  const require = createRequire(fileURLToPath(new URL(module.pkg, import.meta.url)));
  const wrapperDir = dirname(require.resolve("@napi-rs/canvas"));
  const wrapper = JSON.parse(await readFile(join(wrapperDir, "package.json"), "utf8")) as {
    version: string;
  };
  expect(staged).toBe(wrapper.version);
});
