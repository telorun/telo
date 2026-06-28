import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/trace-context/telo.yaml");

type Payload = Record<string, unknown> | undefined;

describe("trace context — root scope on a trace's root span", () => {
  it("attaches the redacted CEL root scope (secrets masked) to the root span", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(APP);
    await kernel.boot();
    kernel.setTracing(true);

    const echoes: Payload[] = [];
    kernel.on("Echo.Invoked", (e) => {
      echoes.push(e.payload as Payload);
    });

    // A top-level invoke is a trace root → its terminal span carries the scope.
    await kernel.invoke("Run.Value.Echo", { value: 1 });

    const ctx = echoes[0]?.context as Record<string, any> | undefined;
    expect(ctx).toBeDefined();
    expect(ctx!.variables).toMatchObject({ greeting: "hello" });
    // Secret keys are listed, values masked.
    expect(ctx!.secrets).toEqual({ apiKey: "[secret]" });
    expect(ctx!.resources).toBeDefined();
    expect(ctx!.ports).toBeDefined();
    // The actual secret value must never appear anywhere in the payload.
    expect(JSON.stringify(echoes[0])).not.toContain("super-secret-value");

    await kernel.teardown();
  });

  it("omits context on non-root (nested) spans", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(APP);
    await kernel.boot();
    kernel.setTracing(true);
    const rootContext = (kernel as unknown as { rootContext: any }).rootContext;

    const byEvent = new Map<string, Payload>();
    kernel.on("*", (e) => {
      if (e.name.endsWith(".Invoked")) byEvent.set(e.name, e.payload as Payload);
    });

    // Outer is the root; its nested Echo invoke inherits the trace and is not a root.
    const outer = {
      invoke: async () => {
        await rootContext.invoke("Run.Value", "Echo", { value: 1 });
        return {};
      },
    };
    rootContext.resourceInstances.set("Outer", {
      resource: { kind: "Test.Outer", metadata: { name: "Outer" } },
      instance: outer,
    });
    await rootContext.invokeResolved("Test.Outer", "Outer", outer, {});

    expect((byEvent.get("Outer.Invoked") as any)?.context).toBeDefined(); // root
    expect((byEvent.get("Echo.Invoked") as any)?.context).toBeUndefined(); // nested

    await kernel.teardown();
  });
});
