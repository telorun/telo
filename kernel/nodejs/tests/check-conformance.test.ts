import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TELO_RUNNING_SURFACE } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/** `analyzer/check-conformance/`: each row is a manifest tree and the refusal a run of
 *  it fails with — `runFails`, or null when it runs. */
const VECTORS = fileURLToPath(new URL("../../../analyzer/check-conformance/vectors/", import.meta.url));

/** The refusal as one text: `[<code>] <message>`, then each diagnostic it carries on a
 *  line of its own as `  [<CODE>] <message>`, relative to the row directory and with this
 *  build's running surface written as `<running-surface>`. */
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
    return relativeToRow(lines.join("\n"), dir).split(TELO_RUNNING_SURFACE).join("<running-surface>");
  }
}

/** `text` with the row directory's prefix removed, so a file reads relative to it with `/`
 *  separators on every platform. */
function relativeToRow(text: string, dir: string): string {
  const parts = text.split(`${pathToFileURL(dir).href}/`).join("").split(`${dir}${sep}`);
  if (sep === "/") return parts.join("");
  return parts
    .map((part, i) => (i === 0 ? part : part.replace(/^[^\s()'"`]*/, (path) => path.split(sep).join("/"))))
    .join("");
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
