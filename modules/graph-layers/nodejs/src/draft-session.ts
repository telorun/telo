import {
  createCancellationSource,
  deriveContext,
  InvokeError,
  isCancellationError,
  StepEngine,
  UNCANCELLABLE_CONTEXT,
  type InvokeContext,
  type ResourceContext,
  type ResourceManifest,
  type Step,
} from "@telorun/sdk";
import type { DraftedGraphStore } from "./drafted-graph-store.js";
import { draftClosed, draftIdOf, draftNotFound, resolveDraftedStore } from "./draft-operations.js";

interface DraftSessionManifest extends ResourceManifest {
  store?: unknown;
  steps: Step[];
  inputs?: Record<string, unknown>;
}

/**
 * `GraphLayers.DraftSession` — a region in which every graph or lifecycle
 * operation on one store reads and writes one draft.
 *
 * The region is a zone on the `steps` slot, correlated on the store: the store
 * recognises a call made inside it by that zone in the call's context, and
 * keeps what it knows about the session in its own map, keyed on the zone
 * entry minted here.
 *
 * The body runs under a cancellation source of the session's own, linked to
 * the caller's. It is what lets a draft closed under a running session end
 * that session whole: the store cancels the source, the operation that found
 * the draft closed stops as a cancellation, no `try:` in the body absorbs it —
 * the engine never catches a cancellation of the invocation it runs — and every
 * later step is refused before it is dispatched. Only here, where it is known
 * that the store cancelled and the caller did not, does the cancellation
 * become `GRAPH_DRAFT_CLOSED`.
 */
class DraftSessionController {
  private readonly engine: StepEngine;

  constructor(
    private readonly describe: string,
    private readonly resource: DraftSessionManifest,
    private readonly ctx: ResourceContext,
    private readonly store: DraftedGraphStore,
  ) {
    this.engine = new StepEngine(ctx, {
      kind: "DraftSession",
      resourceName: String(resource.metadata.name),
    });
  }

  async init(): Promise<void> {
    this.engine.resolveInvokes(this.resource.steps);
  }

  async invoke(input: { draft?: unknown } | undefined, invokeCtx?: InvokeContext): Promise<unknown> {
    const draft = draftIdOf(this.describe, input?.draft);
    const cel = { inputs: input ?? {} };
    const inputs = this.ctx.expandValue(this.resource.inputs ?? {}, cel) as Record<string, unknown>;

    const session = createCancellationSource();
    const caller = invokeCtx ?? UNCANCELLABLE_CONTEXT;
    const unlink = caller.cancellation.onCancelled((reason) => session.cancel(reason));
    try {
      return await this.ctx.withZone(
        "steps",
        async (zoneCtx, entry) => {
          const opened = await this.store.openSession(entry, draft, session, zoneCtx);
          switch (opened.status) {
            case "opened":
              break;
            case "draftNotFound":
              return draftNotFound(this.describe, this.store, draft);
            case "draftClosed":
              return draftClosed(this.describe, draft, opened);
            case "draftForeign":
              throw new InvokeError(
                "GRAPH_DRAFT_FOREIGN",
                `${this.describe}: draft '${draft}' belongs to another layer than ` +
                  `'${this.store.layer}', so this store cannot open a session on it.`,
                { draft },
              );
          }
          const steps: Record<string, unknown> = {};
          let failure: { error: unknown } | undefined;
          try {
            await this.engine.executeSteps(this.resource.steps, steps, undefined, { inputs }, zoneCtx);
          } catch (error) {
            failure = { error };
          }
          const closed = this.store.closeSession(entry);
          if (!failure) return steps;
          if (closed && isCancellationError(failure.error) && !caller.cancellation.isCancelled) {
            return draftClosed(this.describe, draft, closed);
          }
          throw failure.error;
        },
        deriveContext(caller, { cancellation: session.token }),
      );
    } finally {
      unlink();
      session.dispose();
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const DraftSession = {
  register(): void {},
  async create(
    resource: DraftSessionManifest,
    ctx: ResourceContext,
  ): Promise<DraftSessionController> {
    const describe = `GraphLayers.DraftSession "${resource.metadata.name}"`;
    return new DraftSessionController(
      describe,
      resource,
      ctx,
      resolveDraftedStore(resource.store, ctx, describe),
    );
  },
};
