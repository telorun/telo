import { describe, expect, it } from "vitest";
import { EvaluationContext } from "../src/evaluation-context.js";

/**
 * A dispatch that misses BECAUSE THE RUNTIME WITHDREW THE RESOURCE is a
 * cancellation, not a manifest defect, and the distinction is durable where the
 * withdrawal is not.
 *
 * An unwind removes each instance as it goes, so work still in flight finds an
 * emptying map — a detached durable run the kernel waited for and then abandoned
 * above all, since its ambient scope is the uncancellable root and nothing else
 * ever tells it to stop. Reported as `ERR_RESOURCE_NOT_FOUND`, that verdict was
 * recorded as a run failure, which is terminal: one ordinary Ctrl-C left a run id
 * nothing would ever pick up again, from the one feature whose whole purpose is
 * surviving that.
 *
 * Both ways an instance can be withdrawn are covered, because they are the same
 * failure and only one of them is a shutdown: `teardownResources` moves the
 * context's state, while `unwindResources` — the reconciliation half, which a
 * watch session takes on every save — deliberately does not. Keying the verdict
 * on the state rather than on the withdrawal itself converts the first and misses
 * the second.
 *
 * Every consumer already handles a cancellation correctly — a durable body leaves
 * the run `running` for the resumer, and a step's retry budget is not spent
 * re-issuing a call nobody intends to answer — so the conversion needs no
 * cooperation from any of them.
 */
type Emitted = { event: string; payload: any };

function contextWith(...names: string[]): { ctx: EvaluationContext; events: Emitted[] } {
  const events: Emitted[] = [];
  const ctx = new EvaluationContext(
    "test",
    {},
    async (_owner, resource) => ({
      resource,
      instance: { kind: resource.kind, invoke: async () => ({}) } as any,
      ctx: {},
    }),
    new Set(),
    async (event: string, payload: any) => {
      events.push({ event, payload });
    },
  );
  for (const name of names) {
    ctx.registerManifest({ kind: "Some.Kind", metadata: { name } } as any);
  }
  return { ctx, events };
}

const cancellations = (events: Emitted[]): Emitted[] =>
  events.filter((e) => e.event.endsWith(".InvokeCancelled"));

describe("dispatch against a resource the runtime withdrew", () => {
  it("reports a missing target as a manifest defect while the context is live", async () => {
    const { ctx } = contextWith("here");
    await ctx.initializeResources();

    await expect(ctx.invoke("Some.Kind", "gone", {})).rejects.toMatchObject({
      code: "ERR_RESOURCE_NOT_FOUND",
    });
  });

  it("reports it as a cancellation once teardown has begun", async () => {
    const { ctx } = contextWith("gone");
    await ctx.initializeResources();
    // The real path: teardown empties `resourceInstances` and leaves the context
    // in a terminal state, which is exactly what an abandoned task dispatching
    // one tick later walks into.
    await ctx.teardownResources();

    await expect(ctx.invoke("Some.Kind", "gone", {})).rejects.toMatchObject({
      code: "ERR_INVOKE_CANCELLED",
    });
  });

  it("reports it as a cancellation when a reconcile unwound the resource", async () => {
    const { ctx } = contextWith("gone");
    await ctx.initializeResources();
    // The reconciliation path leaves the context live — neither draining nor
    // torn down — so the state says nothing here and only the withdrawal does.
    await ctx.unwindResources(new Set(["gone"]));
    expect(ctx.state).not.toBe("Draining");
    expect(ctx.state).not.toBe("Teardown");

    await expect(ctx.invoke("Some.Kind", "gone", {})).rejects.toMatchObject({
      code: "ERR_INVOKE_CANCELLED",
    });
  });

  it("announces it in the SPAN shape every other cancellation carries", async () => {
    // Not decoration: consumers read `ref.kind` (the debug UI's kind facet) and
    // `outcome` (its graph nodes and its outcome tally) off the trace payload, so
    // an event carrying an ad-hoc `{resource, reason}` fires and is invisible in
    // exactly the surface an operator watches during a reload. Asserting the
    // payload rather than only the thrown code is what would have caught that.
    const { ctx, events } = contextWith("gone");
    await ctx.initializeResources();
    await ctx.unwindResources(new Set(["gone"]));
    events.length = 0;

    await expect(ctx.invoke("Some.Kind", "gone", {})).rejects.toMatchObject({
      code: "ERR_INVOKE_CANCELLED",
    });

    const [cancelled, ...rest] = cancellations(events);
    expect(rest).toEqual([]);
    expect(cancelled.event).toBe("gone.InvokeCancelled");
    expect(cancelled.payload).toMatchObject({
      ref: { kind: "Some.Kind", name: "gone" },
      capability: "invoke",
      phase: "end",
      outcome: "cancelled",
    });
    expect(typeof cancelled.payload.ref.id).toBe("string");
    expect(cancelled.payload.reason).toContain("reconciled");
  });

  it("goes back to reporting a defect once the name is live again", async () => {
    const { ctx } = contextWith("back");
    await ctx.initializeResources();
    await ctx.unwindResources(new Set(["back"]));
    // A reconcile re-initializes what it unwound. A mark left behind would report
    // a genuine missing-resource defect at this name as a cancellation for the
    // rest of the process — this conversion's own failure, inverted.
    ctx.registerManifest({ kind: "Some.Kind", metadata: { name: "back" } } as any);
    await ctx.initializeResources();

    // Dispatching it works again, which is the only thing that proves the mark
    // was cleared rather than merely shadowed by the live entry.
    await expect(ctx.invoke("Some.Kind", "back", {})).resolves.toBeDefined();

    // And a SECOND withdrawal marks it afresh, so the mark tracks the current
    // life of the name rather than accumulating over its history.
    await ctx.unwindResources(new Set(["back"]));
    await expect(ctx.invoke("Some.Kind", "back", {})).rejects.toMatchObject({
      code: "ERR_INVOKE_CANCELLED",
    });
  });
});
