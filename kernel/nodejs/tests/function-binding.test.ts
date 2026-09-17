import { existsSync, readFileSync } from "fs";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Logger, ResourceInstance } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { bindFunction } from "../src/function-binding.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * The function binding: a native callable kind's controller receives a
 * function's context, and every callable instance's `call` is bound to the
 * signature.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (file: string) => path.resolve(here, "__fixtures__/native-function", file);
const probe = () =>
  (globalThis as unknown as { __nativeFunctionProbe: { contexts: string[][]; released: number } })
    .__nativeFunctionProbe;

async function boot(file: string): Promise<Kernel> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(fixture(file));
  await kernel.boot();
  return kernel;
}

function callOf(kernel: Kernel, name: string): (args: Record<string, unknown>) => unknown {
  const ctx = (kernel as unknown as { rootContext: any }).rootContext;
  const instance = ctx.resourceInstances.get(name).instance as {
    call: (args: Record<string, unknown>) => unknown;
  };
  return (args) => instance.call(args);
}

describe("a native function", () => {
  it("gets a context offering only files, logging and effects", async () => {
    const kernel = await boot("telo.yaml");
    expect(probe().contexts.at(-1)).toEqual([
      "effect",
      "log",
      "resolveControllerFile",
      "resolveNativeFile",
    ]);
    await kernel.teardown();
  });

  it("fills defaults and hands arguments over as CEL values", async () => {
    const kernel = await boot("telo.yaml");
    const pad = callOf(kernel, "pad");
    expect(pad({ text: "a" })).toBe("-:a:bigint:8");
    expect(pad({ text: "a", width: 3 })).toBe("-:a:bigint:3");
    await kernel.teardown();
  });

  it("refuses arguments and results its signature does not admit", async () => {
    const kernel = await boot("telo.yaml");
    expect(() => callOf(kernel, "pad")({ text: 1 })).toThrowError(
      expect.objectContaining({ code: "ERR_INPUT_INVALID" }),
    );
    expect(() => callOf(kernel, "wrong")({})).toThrowError(
      expect.objectContaining({ code: "ERR_OUTPUT_INVALID" }),
    );
    await kernel.teardown();
  });

  it("refuses a promise returned from call", async () => {
    const kernel = await boot("telo.yaml");
    expect(() => callOf(kernel, "eventually")({})).toThrowError(
      expect.objectContaining({ code: "ERR_FUNCTION_ASYNC" }),
    );
    await kernel.teardown();
  });

  it("reports a refused promise that later rejects, rather than leaving the rejection unhandled", async () => {
    const reported: unknown[] = [];
    const rejection = new Error("late");
    const instance = { call: () => Promise.reject(rejection) } as unknown as ResourceInstance;
    bindFunction(
      instance,
      "Test.Fn/late",
      {},
      () => ({ validate: () => {} }),
      () => undefined,
      { error: (_message: string, _attributes: unknown, options: { error: unknown }) => reported.push(options.error) } as unknown as Logger,
    );

    expect(() => (instance as unknown as { call: (a: object) => unknown }).call({})).toThrowError(
      expect.objectContaining({ code: "ERR_FUNCTION_ASYNC" }),
    );
    await Promise.resolve();
    expect(reported).toEqual([rejection]);
  });

  it("releases what create allocated when the kernel tears down", async () => {
    const kernel = await boot("telo.yaml");
    const before = probe().released;
    await kernel.teardown();
    expect(probe().released).toBe(before + 1);
  });

  it("destroys a Rust function's instance when the kernel tears down", async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), "native-function-")), "dropped");
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: { MARKER: marker } });
    await kernel.load(fixture("rust-marked.yaml"));
    await kernel.boot();
    expect(callOf(kernel, "marked")({})).toBe(marker);
    expect(existsSync(marker)).toBe(false);
    await kernel.teardown();
    expect(readFileSync(marker, "utf8")).toBe("dropped");
  }, 600_000);

  it("refuses a controller with no create, or an instance with no synchronous call, naming the function", async () => {
    await expect(boot("no-create.yaml")).rejects.toThrow(
      /Function 'NativeFunctionNoCreateApp.NoCreate\/broken': .*exports neither create\(\) nor register\(\)/,
    );
    await expect(boot("no-call.yaml")).rejects.toThrow(
      /Function 'NativeFunctionNoCallApp.NoCall\/broken': its controller's create\(\) returned an instance with no call/,
    );
    await expect(boot("async-call.yaml")).rejects.toThrow(
      /Function 'NativeFunctionAsyncCallApp.AsyncCall\/broken': its call\(args\) is declared async/,
    );
  });
});
