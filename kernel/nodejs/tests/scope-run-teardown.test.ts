import { describe, expect, it } from "vitest";
import { Stream, type ResourceInstance, type ResourceManifest } from "@telorun/sdk";
import { bindEffectOwner } from "../src/effect-scope.js";
import { runWithAmbientContext } from "../src/evaluation-context.js";
import { HeldStream, holdersOf, rootOwner } from "../src/held-streams.js";
import { recordBoundInput, type BoundContract } from "../src/invocation-contract-binding.js";
import { ModuleContext } from "../src/module-context.js";
import { errorRedactionOf } from "../src/scope-run-redaction.js";

const refusingEffects = {
  openFrame: () => {},
  unwindAll: async () => [{ reason: "release", error: new Error("boom s3cr3t") }],
};

/** A module whose scoped members are instances that refuse to unwind. */
function moduleContext(): ModuleContext {
  return new ModuleContext(
    "test",
    {},
    {},
    {},
    [],
    async (_ctx, resource) => {
      const instance = { snapshot: () => ({}) } as unknown as ResourceInstance;
      bindEffectOwner(instance, {
        effects: refusingEffects,
        drainDetached: async () => {},
        log: { error: () => {} },
      } as never);
      return { resource, instance, ctx: {} };
    },
    async () => {},
  );
}

const member = { kind: "Test.Scoped", metadata: { name: "inner" } } as unknown as ResourceManifest;

const sensitiveApiKey = {
  direction: "inputType",
  validate: () => {},
  defaultPaths: () => [],
  scalarPaths: () => [],
  sensitivePaths: () => [["apiKey"]],
  spanAttributes: () => [],
  resolveProjections: () => {},
  buildMembers: (value: unknown) => ({ value, redacted: [], refusals: [] }),
  payloadView: (value: unknown) => value,
} as unknown as BoundContract;

const underOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithAmbientContext({ owner: rootOwner() } as never, fn);

const oneItem = (): Stream<string> =>
  new Stream(
    (async function* () {
      yield "a";
    })(),
  );

describe("a scope run that fails while a stream leaves it", () => {
  it("cancels the stream, so detached work pulling it raises ERR_INVOKE_CANCELLED", async () => {
    const parent = moduleContext();
    const ambient = { owner: rootOwner() } as never;
    let held!: Stream<string>;
    await runWithAmbientContext(ambient, async () => {
      const holderOwner = (ambient as { owner: ReturnType<typeof rootOwner> }).owner;
      await expect(
        parent.createScopeHandle([]).run(async () => {
          // What detached work handed a stream from inside the run holds.
          const wrapped = new HeldStream(oneItem(), "Test.Seq 'seq'", holdersOf(holderOwner), undefined);
          wrapped.registerWith(rootOwner());
          held = wrapped.stream as Stream<string>;
          throw new Error("holder failed");
        }),
      ).rejects.toThrow("holder failed");
    });
    const pull = async () => {
      for await (const item of held) void item;
    };
    await expect(pull()).rejects.toMatchObject({ code: "ERR_INVOKE_CANCELLED" });
  });
});

describe("a deferred scope run teardown that fails", () => {
  const holder = { kind: "Test.Seq", metadata: { name: "seq" } } as unknown as ResourceManifest;

  it("is logged on the holder's logger as scope.teardown.failed, redacted by the run's set", async () => {
    const parent = moduleContext();
    const logged: Array<{ message: string; options: { error: unknown; eventName: string } }> = [];
    const holderInstance = {} as ResourceInstance;
    recordBoundInput(holderInstance, sensitiveApiKey);
    bindEffectOwner(holderInstance, {
      effects: { unwindAll: async () => [] },
      drainDetached: async () => {},
      log: { error: (message: string, _attributes: unknown, options: never) => logged.push({ message, options }) },
    } as never);
    parent.resourceInstances.set("seq", { resource: holder, instance: holderInstance } as never);

    const out = (await underOwner(() =>
      parent
        .createScopeHandle([member], holder, "with", true)
        .run({ apiKey: "s3cr3t" }, async () => ({ output: oneItem() })),
    )) as { output: Stream<string> };
    for await (const item of out.output) void item;
    await parent.settlePendingRuns(false);

    expect(logged).toHaveLength(1);
    expect(logged[0]!.message).toBe("Scope teardown failed");
    expect(logged[0]!.options.eventName).toBe("scope.teardown.failed");
    expect(errorRedactionOf(logged[0]!.options.error)?.scrub("boom s3cr3t")).toBe("boom [redacted]");
  });

  it("with no holder logger, surfaces from the shutdown cascade instead of rejecting or going unhandled", async () => {
    const parent = moduleContext();
    await underOwner(() => parent.createScopeHandle([member]).run(async () => ({ output: oneItem() })));

    await expect(parent.teardownResources()).rejects.toMatchObject({ code: "ERR_TEARDOWN_FAILED" });
  });
});
