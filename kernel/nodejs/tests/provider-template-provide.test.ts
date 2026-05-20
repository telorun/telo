import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const WITH_RESULT = path.resolve(here, "__fixtures__/provider-template-with-result/telo.yaml");
const NO_RESULT = path.resolve(here, "__fixtures__/provider-template-no-result/telo.yaml");
const INVOKE_RESULT = path.resolve(here, "__fixtures__/invoke-result-mapping/telo.yaml");
const MISSING_IMPL = path.resolve(here, "__fixtures__/provider-missing-implementation/telo.yaml");

function makeKernel(): Kernel {
  return new Kernel({ sources: [new LocalFileSource()], env: {} });
}

function readProvideValue(kernel: Kernel, name: string): Promise<unknown> {
  const ctx = (kernel as unknown as { rootContext: any }).rootContext;
  const entry = ctx.resourceInstances.get(name);
  if (!entry?.instance?.provide) {
    throw new Error(`resource '${name}' has no synthesized provide()`);
  }
  return entry.instance.provide();
}

describe("template provider — provide() dispatcher", () => {
  it("synthesizes provide() that calls the dispatch target and applies result: mapping", async () => {
    const kernel = makeKernel();
    await kernel.load(WITH_RESULT);
    await kernel.boot();

    const value = await readProvideValue(kernel, "VaultToken");
    expect(value).toEqual({ token: "bearer s3cret" });

    await kernel.teardown();
  });

  it("returns the raw target output when no result: mapping is declared", async () => {
    const kernel = makeKernel();
    await kernel.load(NO_RESULT);
    await kernel.boot();

    const value = await readProvideValue(kernel, "PlainToken");
    expect(value).toEqual({ raw: "abc" });

    await kernel.teardown();
  });

  it("applies top-level result: mapping when the template uses invoke: instead of provide:", async () => {
    const kernel = makeKernel();
    await kernel.load(INVOKE_RESULT);
    await kernel.boot();

    const value = (await kernel.invoke("Lib.GreetWrapper.Greeter", { who: "world" })) as Record<
      string,
      unknown
    >;
    expect(value).toEqual({ shouted: "hello world!" });

    await kernel.teardown();
  });

  it("rejects a Telo.Provider definition lacking both controllers: and provide: at boot", async () => {
    const kernel = makeKernel();
    await kernel.load(MISSING_IMPL);
    await expect(kernel.boot()).rejects.toThrow(
      /capability: Telo\.Provider' requires either 'controllers:' .* or 'provide:'/,
    );
  });

  it("tears down ephemeral targets after each provide() call", async () => {
    const kernel = makeKernel();
    await kernel.load(WITH_RESULT);
    await kernel.boot();

    const ctx = (kernel as unknown as { rootContext: any }).rootContext;
    const before = ctx.resourceInstances.size;
    await readProvideValue(kernel, "VaultToken");
    await readProvideValue(kernel, "VaultToken");
    const after = ctx.resourceInstances.size;

    expect(after).toBe(before);

    await kernel.teardown();
  });
});
