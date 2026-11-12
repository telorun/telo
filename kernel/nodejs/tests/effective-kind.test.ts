import * as path from "path";
import { fileURLToPath } from "url";
import Ajv from "ajv";
import { StaticAnalyzer } from "@telorun/analyzer";
import type { ResourceDefinition } from "@telorun/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, "__fixtures__/effective-kind/telo.yaml");
const KINDS = ["Reporter", "Counter", "Fixed"];

/** Each definition's derived-capable fields, as plain data. */
function writtenFields(definitions: readonly (ResourceDefinition | undefined)[]) {
  return definitions.map((definition) =>
    JSON.parse(
      JSON.stringify({
        schema: definition?.schema ?? null,
        status: definition?.status ?? null,
        throws: (definition as { throws?: unknown } | undefined)?.throws ?? null,
      }),
    ),
  );
}

const definitionsIn = (manifests: readonly { kind: string; metadata?: { name?: string } }[]): ResourceDefinition[] =>
  KINDS.map(
    (name) => manifests.find((m) => m.kind === "Telo.Definition" && m.metadata?.name === name) as ResourceDefinition,
  );

afterEach(() => vi.restoreAllMocks());

describe("a kind's meaning along extends is a query, not a stamp", () => {
  it("leaves every definition as the loader produced it, after analysis and after boot", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    const written = writtenFields(definitionsIn(await kernel.loadManifests(fixture)));

    const analyzed = await kernel.loadManifests(fixture);
    new StaticAnalyzer().analyze(analyzed);
    expect(writtenFields(definitionsIn(analyzed))).toEqual(written);

    await kernel.load(fixture);
    await kernel.boot();
    const registry = kernel.getAnalysisRegistry();
    const root = (kernel as unknown as { rootContext: { getDefinition(kind: string): ResourceDefinition } })
      .rootContext;
    expect(writtenFields(KINDS.map((name) => registry.resolveDefinition(`EffectiveKindKernel.${name}`)))).toEqual(
      written,
    );
    expect(writtenFields(KINDS.map((name) => root.getDefinition(`EffectiveKindKernel.${name}`)))).toEqual(written);
    expect(registry.effectiveKind("EffectiveKindKernel.Counter")).toMatchObject({
      schema: { properties: { times: { type: "integer" } } },
      status: { properties: { count: { type: "integer" } } },
      throws: { codes: { REPORTER_FAILED: expect.anything() } },
      capability: "Telo.Provider",
    });
    await kernel.teardown();
  });

  it("compiles a merge-form child's status validator once however often it reports", async () => {
    const compile = vi.spyOn(Ajv.prototype, "compile");
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(fixture);
    await kernel.boot();
    const status = kernel.getAnalysisRegistry().effectiveKind("EffectiveKindKernel.Counter")!.status;
    expect(compile.mock.calls.filter(([schema]) => schema === status)).toHaveLength(1);
    await kernel.teardown();
  });

  it("binds an empty merge-form child's contract to its parent's projection", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(fixture);
    await kernel.boot();
    const signup = "EffectiveKindKernel.Signup.signup";
    await expect(kernel.invoke(signup, { values: { age: 3 } })).resolves.toEqual({ values: { age: 3n } });
    await expect(kernel.invoke(signup, { values: { age: "three" } })).rejects.toMatchObject({
      code: "ERR_OUTPUT_INVALID",
    });
    await kernel.teardown();
  });

  it("answers a child's schema from its parent's current registration", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(fixture);
    await kernel.boot();
    const registry = kernel.getAnalysisRegistry();
    const child = registry.resolveDefinition("EffectiveKindKernel.Counter")!;
    const childWritten = writtenFields([child]);
    const parent = registry.resolveDefinition("EffectiveKindKernel.Reporter")!;
    kernel.registerResourceDefinition({
      ...parent,
      schema: { ...parent.schema, properties: { ...parent.schema!.properties, label: { type: "string" } } },
    } as ResourceDefinition);

    expect(Object.keys(registry.effectiveKind("EffectiveKindKernel.Counter")!.schema!.properties)).toEqual([
      "times",
      "label",
    ]);
    expect(writtenFields([registry.resolveDefinition("EffectiveKindKernel.Counter")])).toEqual(childWritten);
    await kernel.teardown();
  });

  it.each(["template", "delegation"])(
    "reaches a controller across a three-module chain, each hop resolved in its own module (%s)",
    async (app) => {
      const runs = ((globalThis as Record<string, unknown>).__effectiveKindChainRuns = [] as string[]);
      const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
      await kernel.load(path.resolve(here, "__fixtures__/effective-kind/chain", app, "telo.yaml"));
      await kernel.boot();
      await kernel.runTargets();
      expect(runs).toEqual(["Task"]);
      await kernel.teardown();
    },
  );
});
