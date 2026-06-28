import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/application-trace-span/telo.yaml");

type Payload = Record<string, unknown> | undefined;

describe("application trace span — the app is a trace participant", () => {
  it("roots the boot targets under an application span and nests them through the chokepoint", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(APP);
    await kernel.boot();
    kernel.setTracing(true);

    const byName = new Map<string, Payload>();
    kernel.on("*", (event) => {
      // First terminal event per name is enough for these assertions.
      if (!byName.has(event.name)) byName.set(event.name, event.payload as Payload);
    });

    await kernel.runTargets();

    const app = byName.get("AppTraceSpanApp.Run");
    const seq = byName.get("Seq.Run");
    const echo = byName.get("Echo.Invoked");

    // The application is the trace root.
    expect(app).toMatchObject({ capability: "run", phase: "end", outcome: "ok", ref: { kind: "Telo.Application", name: "AppTraceSpanApp" } });
    expect(typeof app?.spanId).toBe("number");
    expect(app?.parentSpanId).toBeUndefined();

    // A bare `!ref` runnable target is dispatched through the chokepoint
    // (runResolved), so it emits its own run span parented to the app.
    expect(seq).toMatchObject({ capability: "run", ref: { kind: "Run.Sequence", name: "Seq" } });
    expect(seq?.parentSpanId).toBe(app?.spanId);

    // The sequence's step invoke nests under the sequence.
    expect(echo).toMatchObject({ capability: "invoke", ref: { kind: "Run.Value", name: "Echo" } });
    expect(echo?.parentSpanId).toBe(seq?.spanId);

    await kernel.teardown();
  });
});
