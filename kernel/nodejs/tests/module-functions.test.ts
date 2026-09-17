import {
  ERR_DURABLE_SUSPENDED,
  ERR_FUNCTION_FAILED,
  ERR_INVOKE_CANCELLED,
  InvokeError,
  isInvokeError,
  RuntimeError,
  type CompiledValue,
  type Logger,
  type ResourceInstance,
  type ResourceManifest,
  type RuntimeDiagnostic,
} from "@telorun/sdk";
import type { SignatureParam, SignatureResult } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { bindFunction } from "../src/function-binding.js";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import { ModuleContext } from "../src/module-context.js";
import { callableEntry, ModuleFunctionTable } from "../src/module-functions.js";

const noShapes = () => undefined;

/** A compiled value as the loader leaves it: the calls it makes, and a body. */
function compiled(calls: string[], call: CompiledValue["call"] = () => null): CompiledValue {
  return { __compiled: true, source: calls.join(" "), calls, call };
}

describe("the dispatch table", () => {
  it("resolves a qualified call once per scope, however many expressions make it", () => {
    const table = new ModuleFunctionTable();
    let resolutions = 0;
    const resolve = () => {
      resolutions += 1;
      return { holder: "double", call: (args: readonly unknown[]) => args[0] };
    };

    table.bind("Self.double", resolve);
    table.bind("Self.double", resolve);
    table.dispatch.get("Self.double")!([1n]);
    table.dispatch.get("Self.double")!([2n]);

    expect(resolutions).toBe(1);
  });

  it("drops what a withdrawn provider served, and binds its replacement afresh", () => {
    const table = new ModuleFunctionTable();
    table.bind("Self.double", () => ({ holder: "double", call: () => "old" }));
    const inFlight = table.dispatch.get("Self.double")!;

    table.withdraw("double", "the runtime is shutting down");

    expect(() => table.dispatch.get("Self.double")!([])).toThrowError(
      expect.objectContaining({ code: ERR_INVOKE_CANCELLED }),
    );
    table.bind("Self.double", () => ({ holder: "double", call: () => "new" }));
    expect(table.dispatch.get("Self.double")!([])).toBe("new");
    expect(inFlight([])).toBe("old");
  });
});

/** A callable instance as the kernel creates it: its `call` bound to the
 *  signature, with validation left to the kernel tests that boot one. */
function created(
  call: (args: Record<string, unknown>) => unknown,
  params: SignatureParam[] = [],
  returns?: SignatureResult,
): ResourceInstance {
  const instance = { call } as unknown as ResourceInstance;
  bindFunction(
    instance,
    "Test.Fn/fn",
    { params, returns },
    () => ({ validate: () => {} }),
    noShapes,
    {} as Logger,
  );
  return instance;
}

describe("a callable's dispatch entry", () => {
  const echo = (params: SignatureParam[]) => created((args) => args, params);

  it("fills an omitted optional parameter from its default, in the declared representation", () => {
    const params: SignatureParam[] = [
      { name: "text", schema: { type: "string" } },
      { name: "width", schema: { type: "integer", default: 8 }, optional: true },
      { name: "fill", schema: { type: "string" }, optional: true },
    ];
    const entry = callableEntry("Self.pad", echo(params), params, noShapes);

    expect(entry(["x"])).toEqual({ text: "x", width: 8n, fill: null });
  });

  it("hands every call its own copy of a default", () => {
    const params: SignatureParam[] = [
      { name: "tags", schema: { type: "array", default: [] }, optional: true },
    ];
    const pushing = created((args) => {
      (args.tags as unknown[]).push("seen");
      return args.tags;
    }, params);
    const entry = callableEntry("Self.tag", pushing, params, noShapes);

    entry([]);
    expect(entry([])).toEqual(["seen"]);
  });

  it("hands an argument over in the representation its parameter declares", () => {
    const params: SignatureParam[] = [
      { name: "x", schema: { type: "number" } },
      { name: "n", schema: { type: "integer" }, nullable: true },
    ];
    const entry = callableEntry("Self.half", echo(params), params, noShapes);

    expect(entry([3n, 4])).toEqual({ x: 3, n: 4n });
  });

  it("returns the result in the representation its signature declares", () => {
    const one = created(() => 1n, [], { schema: { type: "number" } });
    const entry = callableEntry("Self.ratio", one, [], noShapes);

    expect(entry([])).toBe(1);
  });

  it("refuses an argument count no parameter list accepts, as a structured error", () => {
    const params: SignatureParam[] = [{ name: "text" }];
    const entry = callableEntry("Self.pad", echo(params), params, noShapes);

    let thrown: unknown;
    try {
      entry(["a", "b"]);
    } catch (error) {
      thrown = error;
    }
    expect(isInvokeError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: "ERR_FUNCTION_ARITY_MISMATCH" });
  });

  it("lets a suspension raised inside a callable leave unwrapped", () => {
    const parking = created(() => {
      throw new InvokeError(ERR_DURABLE_SUSPENDED, "parked");
    });
    const entry = callableEntry("Self.wait", parking, [], noShapes);

    expect(() => entry([])).toThrowError(expect.objectContaining({ code: ERR_DURABLE_SUSPENDED }));
  });

  it("reports what the callable threw as ERR_FUNCTION_FAILED, keeping the thrown code", () => {
    const failing = created(() => {
      throw new InvokeError("ERR_KEY_REJECTED", "key too short");
    });
    const entry = callableEntry("Crypto.sign", failing, [], noShapes);

    try {
      entry([]);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        code: ERR_FUNCTION_FAILED,
        data: { function: "Crypto.sign", code: "ERR_KEY_REJECTED", message: "key too short" },
      });
    }
  });
});

describe("module calls in a module context", () => {
  it("records a call as a dependency on the callee, or on the import it goes through", async () => {
    const ctx = new ModuleContext(
      "test",
      {},
      {},
      {},
      [],
      async (_ctx, resource) => ({ resource, instance: {}, ctx: {} }),
      async () => {},
    );
    ctx.registerUngatedAlias("Self", "App");
    const manifest = (name: string, extra: Record<string, unknown> = {}) =>
      ({ kind: "Test.Thing", metadata: { name }, ...extra }) as unknown as ResourceManifest;
    ctx.registerManifest(manifest("fn"));
    ctx.registerManifest(manifest("Billing"));
    ctx.registerManifest(manifest("caller", { value: compiled(["Self.fn"]) }));
    ctx.registerManifest(manifest("importer", { value: compiled(["Billing.total"]) }));
    await ctx.initializeResources();

    expect([...ctx.impactedBy(["fn"]).impacted].sort()).toEqual(["caller", "fn"]);
    expect([...ctx.impactedBy(["Billing"]).impacted].sort()).toEqual(["Billing", "importer"]);
  });

  it("keeps a coded failure's code when an expression fails", () => {
    const ctx = new ModuleContext("test", {}, {}, {}, [], async () => null, async () => {});
    const failing = compiled(["Self.fn"], () => {
      throw new InvokeError(ERR_FUNCTION_FAILED, "Function 'Self.fn' failed: boom", {
        function: "Self.fn",
      });
    });

    expect(() => ctx.expand({ value: failing })).toThrowError(
      expect.objectContaining({ code: ERR_FUNCTION_FAILED, data: { function: "Self.fn" } }),
    );
  });
});

const APP = `kind: Telo.Application
metadata:
  name: App
  version: 1.0.0
imports:
  Lib: memory://lib
`;

/** Every diagnostic in a failure tree, depth first. */
function leaves(diagnostics: readonly RuntimeDiagnostic[] | undefined): RuntimeDiagnostic[] {
  return (diagnostics ?? []).flatMap((d) => [d, ...leaves(d.children)]);
}

async function bootFailure(lib: string): Promise<RuntimeError> {
  const memory = new MemorySource();
  memory.set("app", APP);
  memory.set("lib", lib);
  const kernel = new Kernel({ sources: [memory], env: {} });
  await kernel.load("memory://app");
  try {
    await kernel.boot();
  } catch (error) {
    await kernel.teardown();
    return error as RuntimeError;
  }
  throw new Error("expected boot to fail");
}

describe("module calls in a running kernel", () => {
  it("never reaches a function another in-process kernel declares", async () => {
    const provider = new MemorySource();
    provider.set("app", APP);
    provider.set(
      "lib",
      `kind: Telo.Library
metadata:
  name: Lib
  version: 1.0.0
---
kind: Telo.Function
metadata:
  name: fn
params: [{ name: n, schema: { type: integer } }]
returns: { schema: { type: integer } }
body: !cel "n"
`,
    );
    const first = new Kernel({ sources: [provider], env: {} });
    await first.load("memory://app");
    await first.boot();

    const failure = await bootFailure(`kind: Telo.Library
metadata:
  name: Lib
  version: 1.0.0
---
kind: Telo.Function
metadata:
  name: caller
returns: { schema: { type: integer } }
body: !cel "Self.fn(1)"
`);
    await first.teardown();

    expect(leaves(failure.diagnostics).map((d) => d.code)).toContain("ERR_FUNCTION_UNRESOLVED");
  });

  it("defers a caller while its callee is pending, and blames the callee that never came", async () => {
    const failure = await bootFailure(`kind: Telo.Library
metadata:
  name: Lib
  version: 1.0.0
---
kind: Telo.Function
metadata:
  name: caller
returns: { schema: { type: string } }
body: !cel "Self.broken('x')"
---
kind: Telo.Function
metadata:
  name: broken
params:
  - { name: tail, schema: { type: string }, optional: true }
  - { name: head, schema: { type: string } }
returns: { schema: { type: string } }
body: !cel "head"
`);

    const diagnostics = leaves(failure.diagnostics);
    expect(diagnostics.find((d) => d.resource === "broken")).toMatchObject({
      code: "ERR_CALLABLE_DEFINITION_INVALID",
    });
    expect(diagnostics.find((d) => d.resource === "caller")).toMatchObject({
      code: "ERR_LOCAL_REF_PENDING",
      derived: true,
      blockedBy: "broken",
    });
  });
});
