import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/** `analyzer/check-conformance/`: each row is a manifest tree and the refusal a run of
 *  it fails with — `runFails`, or null when it runs. */
const VECTORS = fileURLToPath(new URL("../../../analyzer/check-conformance/vectors/", import.meta.url));

/** The refusal as one text: `[<code>] <message>`, then each diagnostic it carries on a
 *  line of its own as `  [<CODE>] <message>`, the row directory's prefix removed. */
async function runFails(dir: string): Promise<string | null> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  try {
    await kernel.load(join(dir, "telo.yaml"), { cacheDir: null });
    await kernel.start();
    return null;
  } catch (err) {
    const { code, message, diagnostics } = err as {
      code?: string;
      message: string;
      diagnostics?: Array<{ code?: string; message: string }>;
    };
    const lines = [`[${code}] ${message}`];
    for (const d of diagnostics ?? []) lines.push(d.code ? `  [${d.code}] ${d.message}` : `  ${d.message}`);
    return [`${pathToFileURL(dir).href}/`, `${dir}${sep}`].reduce(
      (text, prefix) => text.split(prefix).join(""),
      lines.join("\n"),
    );
  }
}

describe("check conformance", () => {
  for (const id of readdirSync(VECTORS)) {
    it(id, async () => {
      const dir = join(VECTORS, id);
      const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
      expect(Object.keys(expected).sort()).toEqual(["diagnostics", "runFails"]);
      expect(await runFails(dir)).toBe(expected.runFails);
    });
  }
});
