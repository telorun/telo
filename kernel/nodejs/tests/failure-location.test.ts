import {
  InvokeError,
  isInvokeError,
  type ResourceManifest,
  type RuntimeDiagnostic,
} from "@telorun/sdk";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import type { EvaluationContext } from "../src/evaluation-context.js";
import { failureDiagnostics, locateInvokeFailure } from "../src/failure-location.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.resolve(here, "__fixtures__/failure-location", name);

/** Run `name` to its failure and answer what the kernel reports it with. */
async function failure(name: string): Promise<{ error: unknown; diagnostics: RuntimeDiagnostic[] }> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(fixture(name));
  const error = await kernel.start().then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error, "the fixture's run fails").toBeDefined();
  return { error, diagnostics: kernel.failureDiagnostics(error) };
}

describe("a failure leaving a dispatch is located in the caller's declaration", () => {
  it("locates the innermost failing step of a nested sequence", async () => {
    const { diagnostics } = await failure("nested.yaml");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.location?.pointer).toBe("/steps/1/inputs/expected");
    expect(diagnostics[0]!.origin).toEqual({
      filePath: expect.stringMatching(/failure-location\/nested\.yaml$/),
      resource: { kind: "Run.Sequence", name: "outer" },
      path: "steps[0].invoke.steps[1].inputs.expected",
    });
  });

  it("locates an input the target's inputType refuses at the offending field", async () => {
    const { error, diagnostics } = await failure("input-contract.yaml");
    expect(isInvokeError(error) && error.code).toBe("ERR_INPUT_INVALID");
    expect(diagnostics[0]!.origin?.path).toBe("steps[0].inputs.n");
  });

  it("locates an inline boot target's input in the application's targets", async () => {
    const { diagnostics } = await failure("boot-target.yaml");
    expect(diagnostics[0]!.location).toMatchObject({ kind: "Telo.Application", pointer: "/targets/0/inputs/expected" });
    expect(diagnostics[0]!.origin).toMatchObject({
      resource: { kind: "Telo.Application", name: "FailureBootTarget" },
      path: "targets[0].inputs.expected",
    });
  });

  it("locates a dispatch that names no written place at the calling resource", async () => {
    const { diagnostics } = await failure("no-inputs-at/telo.yaml");
    expect(diagnostics[0]!.location).not.toHaveProperty("pointer");
    expect(diagnostics[0]!.origin).toEqual({
      filePath: expect.stringMatching(/no-inputs-at\/telo\.yaml$/),
      resource: { kind: "Self.Caller", name: "caller" },
    });
  });
});

describe("a place that is not provably the written one is never positioned", () => {
  it("names the resource and no file position when an !if shifted the step's index", async () => {
    const { diagnostics } = await failure("shifted.yaml");
    expect(diagnostics[0]!.location).toMatchObject({ name: "compare", pointer: "/steps/0/inputs/expected" });
    expect(diagnostics[0]!.resource).toBe("compare");
    expect(diagnostics[0]!.origin).toBeUndefined();
  });

  it("names the written root when an inline-extracted caller cannot be positioned", async () => {
    const { diagnostics } = await failure("shifted-inline.yaml");
    expect(diagnostics[0]!.location?.name).not.toBe("outer");
    expect(diagnostics[0]!.origin).toBeUndefined();
    expect(diagnostics[0]!.kind).toBe("Run.Sequence");
    expect(diagnostics[0]!.resource).toBe("outer");
  });

  it("names the resource and no file position for a template body's step", async () => {
    const { diagnostics } = await failure("template-body.yaml");
    expect(diagnostics[0]!.location).toMatchObject({
      name: "SequenceBodySteps0Inner",
      pointer: "/steps/0/inputs/expected",
    });
    expect(diagnostics[0]!.origin).toBeUndefined();
  });

  it("names the resource and no file position for the parent an inherited kind builds", async () => {
    const { diagnostics } = await failure("inherited.yaml");
    expect(diagnostics[0]!.location).toMatchObject({ name: "compare", pointer: "/steps/0/inputs/expected" });
    expect(diagnostics[0]!.origin).toBeUndefined();
  });

  it("positions only a declaration the load read, however closely another matches it", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(fixture("nested.yaml"));
    const graph = kernel.getLoadedGraph();
    await kernel.boot();
    const declared = (kernel as unknown as { rootContext: EvaluationContext }).rootContext.resolveDeclaredManifest(
      "outer",
    )!;
    const locatedWith = (declaration: ResourceManifest) => {
      const err = new InvokeError("ERR_PROBE", "probe");
      locateInvokeFailure(err, { kind: "Run.Sequence", name: "outer", declaration }, "/steps/0/name");
      return failureDiagnostics(err, graph)[0]!.origin;
    };
    expect(locatedWith(declared)).toMatchObject({ path: "steps[0].name" });
    expect(locatedWith({ ...declared, metadata: { ...declared.metadata } })).toBeUndefined();
    await kernel.teardown();
  });
});
