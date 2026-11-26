import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { refuseNonShapeReferences } from "../src/refuse-non-shape-references.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const thing = { kind: "Telo.Value", metadata: { name: "thing" } };
const library = {
  declarationInModule: (module: string, name: string) => (module === "Lib" && name === "thing" ? thing : undefined),
};
const importer = { declarationInModule: () => undefined };

describe("a contract or signature reference naming no named shape", () => {
  it("is refused as ERR_REFERENCE_KIND_MISMATCH where the declaration it names holds no shape", () => {
    expect(() =>
      refuseNonShapeReferences(
        "Telo.Function/measure",
        [{ path: "returns.schema", schema: { type: "array", items: { $ref: "telo:Lib/thing" } }, writer: library }],
        () => undefined,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_REFERENCE_KIND_MISMATCH",
        message: expect.stringContaining("'returns.schema' names 'thing', a Telo.Value, which is not a named shape"),
      }),
    );
  });

  it("passes a reference a shape answers, and one naming nothing, which is not its refusal", () => {
    const sites = [
      { path: "inputType", schema: { $ref: "telo:Lib/Money" }, writer: library },
      { path: "outputType", schema: { $ref: "telo:Lib/missing" }, writer: library },
    ];
    expect(() =>
      refuseNonShapeReferences("Lib.Kind/k", sites, (id) => (id === "telo:Lib/Money" ? {} : undefined)),
    ).not.toThrow();
  });

  it("judges a schema per writer, so one module's clean verdict holds for no other", () => {
    const schema = { $ref: "telo:Lib/thing" };
    refuseNonShapeReferences("Lib.Kind/a", [{ path: "outputType", schema, writer: importer }], () => undefined);
    expect(() =>
      refuseNonShapeReferences("Lib.Kind/b", [{ path: "outputType", schema, writer: library }], () => undefined),
    ).toThrow(expect.objectContaining({ code: "ERR_REFERENCE_KIND_MISMATCH" }));
  });

  // The kind's own document, created in the library, is where the refusal lands:
  // the reference is judged in the library's reach, never the importer's.
  it("refuses a library kind's contract naming a value the library does not export", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await expect(
      (async () => {
        await kernel.load(path.resolve(here, "__fixtures__/non-shape-contract-library/telo.yaml"));
        await kernel.boot();
      })(),
    ).rejects.toThrow(
      "Telo.Definition Measure: RuntimeError: Telo.Definition/Measure: 'outputType' names 'thing', a Telo.Value",
    );
    await kernel.teardown();
  });
});
