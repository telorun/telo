import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildControllerFromSource } from "../src/controller-loaders/source-bundle-builder.js";

describe("controller bundle built from source", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-source-bundle-")));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): string {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  it("refuses a bundle that inlines the CEL engine, naming the module and the SDK", async () => {
    write("node_modules/@marcbachmann/cel-js/package.json", JSON.stringify({
      name: "@marcbachmann/cel-js",
      version: "7.6.1",
      type: "module",
      exports: { "./evaluator": "./lib/evaluator.js" },
    }));
    write("node_modules/@marcbachmann/cel-js/lib/evaluator.js", "export class Duration {}");
    write("modules/clock/telo.yaml", "kind: Telo.Library\nmetadata:\n  name: Clock\n");
    const entry = write(
      "modules/clock/nodejs/src/index.ts",
      'import { Duration } from "@marcbachmann/cel-js/evaluator";\nexport const create = () => new Duration();\n',
    );

    const failure = buildControllerFromSource(entry, path.join(dir, ".telo"));
    await expect(failure).rejects.toMatchObject({ code: "ERR_CONTROLLER_BUILD_FAILED" });
    const moduleDir = path.join(dir, "modules/clock").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await expect(failure).rejects.toThrow(
      new RegExp(`module at ${moduleDir} inlines @marcbachmann/cel-js.*@telorun/sdk`),
    );
  });
});
