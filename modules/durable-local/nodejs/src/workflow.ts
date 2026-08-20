/**
 * `DurableLocal.Workflow` — the single body-dispatch site of this backend.
 *
 * Whatever the engine, exactly one kind holds the body, carries the providing
 * annotation, installs the run handle and drives replay. Everything else in a
 * backend's module addresses runs from OUTSIDE.
 */
import {
  InvokeError,
  StepEngine,
  assertNotSwallowed,
  deriveContext,
  isCancellationError,
  isSuspension,
  type InvokeContext,
  type ResourceContext,
  type ResourceManifest,
  type Step,
} from "@telorun/sdk";
import { isDurableJournal, type DurableJournal } from "./journal.js";
import { LocalRunHandle } from "./run-handle.js";

interface WorkflowManifest extends ResourceManifest {
  journal: unknown;
  runId?: string;
  onConflict?: "attach" | "reject";
  steps: Step[];
  inputs?: Record<string, unknown>;
}

/** How long this instance owns a run it is working. Bounded for the reason every
 *  claim in this repo is: a process that dies must free the run rather than wedge
 *  it. */
const CLAIM_TTL_MS = 60_000;

/** How often a running body renews its claim. A third of the TTL, so two
 *  renewals may be lost — to a slow journal, to a pause — before another poller
 *  is entitled to take the run. Without renewal the bound is not a safety net
 *  but a deadline: any body outliving it would be picked up and executed a
 *  second time WHILE the first was still running, which is the duplication the
 *  claim exists to prevent. */
const CLAIM_RENEW_MS = Math.floor(CLAIM_TTL_MS / 3);

export class WorkflowController {
  private readonly engine: StepEngine;
  /** Identifies this instance as a claim holder, so re-entering a run it already
   *  owns renews rather than collides. */
  readonly #holder = crypto.randomUUID();

  constructor(
    private readonly resource: WorkflowManifest,
    private readonly ctx: ResourceContext,
  ) {
    this.engine = new StepEngine(ctx, {
      kind: "Workflow",
      resourceName: String(resource.metadata.name),
    });
  }

  async init(): Promise<void> {
    this.engine.resolveInvokes(this.resource.steps);
  }

  async invoke(input: unknown, invokeCtx?: InvokeContext): Promise<unknown> {
    const journal = this.journal();
    const cel = { inputs: input ?? {} };
    const runId = this.runIdFor(cel);

    // ADMIT BEFORE EXECUTING — the one rule every backend keeps. A start that
    // executed before it was durably recorded would be unrecoverable if the
    // process died in between; recording first is what lets recovery find a run
    // with no progress and replay it.
    const admission = await journal.admitRun(runId);
    if (!admission.admitted) {
      const existing = admission.existing;
      if ((this.resource.onConflict ?? "attach") === "reject") {
        throw new InvokeError(
          "ERR_DURABLE_RUN_EXISTS",
          `Run '${runId}' already exists (${existing?.status ?? "unknown"}), and this ` +
            `workflow declares onConflict: reject.`,
          { run: runId, status: existing?.status },
        );
      }
      // `attach`: a completed run answers with what it produced rather than
      // doing the work again — which is what makes a caller-chosen run id an
      // idempotent start.
      if (existing?.status === "completed") {
        return { runId, attached: true, status: "completed", result: existing.result };
      }
      if (existing?.status === "failed") {
        throw new InvokeError(
          existing.error?.code ?? "ERR_DURABLE_RUN_FAILED",
          existing.error?.message ?? `Run '${runId}' failed`,
          { run: runId },
        );
      }
      // STILL RUNNING, and this is the case an idempotent start exists for.
      // Falling through here would execute a second copy of a run already in
      // flight — precisely the duplication a caller-chosen id is meant to
      // prevent, and worse than starting two runs, because both would write to
      // one journal and race on every step.
      //
      // The claim is what decides. Taking it means the previous holder is gone
      // (its process died and its claim lapsed), so continuing IS the resume —
      // the same operation the resumer performs, through the same path. Failing
      // to take it means someone is actively working the run, and the honest
      // answer is to say so rather than to invent a result or to join in.
      if (!(await journal.claimRun(runId, this.#holder, CLAIM_TTL_MS))) {
        return { runId, attached: true, status: existing?.status ?? "running" };
      }
    } else if (!(await journal.claimRun(runId, this.#holder, CLAIM_TTL_MS))) {
      // A FRESH admission still claims, and skipping it was a race with the
      // recovery path rather than a missing nicety: an admitted run is recorded
      // `running`, which is exactly what a poller looks for, so between the
      // admission and the body finishing its first step the resumer could take
      // the run and execute a second copy of it. Admit-before-execute is what
      // makes a run recoverable; the claim is what says it does not need
      // recovering yet.
      //
      // Losing this race means another process admitted the same id in the
      // window — the `attach` answer, reached by a different route.
      return { runId, attached: true, status: "running" };
    }

    // DISPATCHED DETACHED, not awaited. A run outlives whatever triggered it —
    // that is what parking makes real — so an HTTP route that starts one gets
    // its run id back immediately and the body keeps going. Awaiting it would
    // also be unable to answer: a body that parks does not return, so the
    // caller would hang until the deadline of a wait measured in days.
    //
    // The outcome is not lost by not being returned: it is in the journal, and
    // `DurableLocal.Result` is how a caller that wants it asks.
    this.start(runId, journal, cel);
    return { runId, started: true, status: "running" };
  }

  /**
   * Run the body detached, holding the kernel while it executes.
   *
   * Two properties, both load-bearing. The HOLD is what stops a one-shot
   * application exiting the moment its trigger returned, mid-run — and it is
   * released when the body settles, *including when it parks*, because a parked
   * run is precisely the state in which the process is free to go away. Holding
   * through a park would keep an application alive for a 72-hour approval.
   *
   * And `runDetached` replaces the ambient cancellation scope with the
   * uncancellable root, so the run is not cancelled the moment the triggering
   * request completes.
   */
  private start(runId: string, journal: DurableJournal, cel: { inputs: unknown }): void {
    const release = this.ctx.acquireHold(`durable run ${runId}`);
    this.ctx.runDetached(async () => {
      try {
        await this.execute(runId, journal, cel);
      } catch (err) {
        // A park is not a failure. It reached here because the signal unwinds to
        // the boundary that owns the run, which is exactly what it is for, and
        // the journal already records where the run is waiting.
        if (isSuspension(err)) return;
        throw err;
      } finally {
        release();
      }
    });
  }

  /**
   * Run (or replay) the body under a run handle.
   *
   * Also the resumer's entry point: continuing an interrupted run and starting a
   * fresh one are the SAME operation, because replay is what a resume is. Two
   * code paths here would be two behaviours to keep agreeing, and the one that
   * ran rarely would be the one that drifted.
   */
  async execute(
    runId: string,
    journal: DurableJournal,
    cel: { inputs: unknown },
    invokeCtx?: InvokeContext,
    /** The claim holder to renew under. The resumer claimed the run as itself,
     *  so renewing as this workflow would fail and the run would be taken from
     *  under it mid-body. */
    holder: string = this.#holder,
  ): Promise<unknown> {
    const handle = await LocalRunHandle.open(runId, journal, this.ctx.log);
    // The claim is held for as long as the body runs, and a body may run far
    // longer than one TTL. Unref'd, so a renewal timer never keeps the process
    // alive on its own — the kernel hold is what does that, and it is released
    // the moment the run settles or parks.
    const renew = setInterval(() => {
      void journal.claimRun(runId, holder, CLAIM_TTL_MS).catch(() => {});
    }, CLAIM_RENEW_MS);
    renew.unref?.();
    try {
      return await this.runBody(runId, journal, cel, invokeCtx, handle);
    } finally {
      clearInterval(renew);
    }
  }

  private async runBody(
    runId: string,
    journal: DurableJournal,
    cel: { inputs: unknown },
    invokeCtx: InvokeContext | undefined,
    handle: LocalRunHandle,
  ): Promise<unknown> {

    // The BODY's inputs are journaled like any other decision, and this one is
    // load-bearing twice over. It is CEL over the call's inputs, so re-deriving
    // it on a resume would break the closure claim — and worse, a resume has no
    // call to derive it from: the resumer continues a run whose original
    // invocation is gone with the process that received it, so re-evaluating
    // `inputs.email` there would silently yield nothing and every step reading
    // it would run against empty values.
    //
    // Recorded at a root key rather than under `steps/`, because it belongs to
    // the run rather than to any step, and step paths are all `steps/`-prefixed
    // so the two can never collide.
    const inputs = (await handle.decide("inputs", "inputs", () =>
      this.ctx.expandValue(this.resource.inputs ?? {}, cel),
    )) as Record<string, unknown>;
    const steps: Record<string, unknown> = {};

    // The body starts outside every enclosing zone: a run outlives whatever
    // triggered it, so no enclosing zone's lifetime may reach it. `rootContext()`
    // is what sheds them, and the workflow's own zone plus the run handle are
    // layered onto THAT root rather than onto the caller's context.
    const root = this.ctx.rootContext();
    const durable = deriveContext(root, { durable: handle });

    try {
      await this.ctx.withZone(
        "steps",
        (zoneCtx) =>
          this.engine.executeSteps(this.resource.steps, steps, undefined, { inputs }, zoneCtx),
        durable,
      );
    } catch (err) {
      // A SUSPENSION is the run leaving, not failing. The park is already
      // recorded, so settling it here would overwrite a live run with a terminal
      // verdict and strand it — the same shape as the cancellation case below,
      // for a different reason.
      if (isSuspension(err)) throw err;
      // A CANCELLED run is interrupted, not failed, and the distinction is the
      // whole of whether it can be recovered. Cancellation is how a process
      // going away reaches the body — Ctrl-C, a shutdown, a drained container —
      // and none of those are a verdict on the WORK. Settling it `failed` would
      // record a judgement the run never earned, and since a failed run is
      // terminal, the next process would refuse to continue it: every crash
      // would produce an unrecoverable run, from the one feature whose entire
      // purpose is surviving crashes.
      //
      // Left `running`, it is exactly what the resumer looks for, and what a
      // later submission of the same id attaches to and continues.
      if (!isCancellationError(err)) {
        await journal.completeRun(runId, {
          status: "failed",
          error: {
            code: (err as { code?: string }).code ?? "INTERNAL_ERROR",
            message: (err as Error).message,
          },
        });
      }
      throw err;
    }

    // THE LATCH. A body that returned normally while a suspension is latched
    // swallowed one: something between the parking kind and here caught the
    // signal and continued, so every step after the park ran outside the journal
    // and this run is about to be recorded as completed. Checked before the
    // settlement, so the false record is never written.
    assertNotSwallowed(handle);

    const result = { steps };
    await journal.completeRun(runId, {
      status: "completed",
      result,
      collapsedRegions: handle.observations.collapsedRegions,
      collapseReasons: handle.observations.collapseReasons,
    });
    // Returned to whoever called `execute` directly — the resumer, and a start
    // that took over a lapsed claim. A caller that STARTED the run gets a run id
    // and reads the outcome through `DurableLocal.Result`, which reads the same
    // facts off the run record this just settled.
    return {
      runId,
      replayed: handle.observations.replayedSteps > 0,
      collapsedRegions: handle.observations.collapsedRegions,
      collapseReasons: handle.observations.collapseReasons,
      result,
    };
  }

  journal(): DurableJournal {
    return this.ctx.resolveRef(
      this.resource.journal,
      isDurableJournal,
      () => `DurableLocal.Workflow "${this.resource.metadata.name}": 'journal'`,
      "DurableLocal.Journal",
    ) as unknown as DurableJournal;
  }

  /** The caller-chosen identity, or a minted one. A caller-chosen id is how an
   *  idempotent start is expressed — submitting the same operation twice
   *  attaches instead of doing it twice — and every engine has its own opinion
   *  about it, which is why this is native rather than shared. */
  private runIdFor(cel: { inputs: unknown }): string {
    if (this.resource.runId === undefined) {
      return `${String(this.resource.metadata.name)}:${crypto.randomUUID()}`;
    }
    const id = this.ctx.expandValue(this.resource.runId, cel);
    if (typeof id !== "string" || id.length === 0) {
      throw new InvokeError(
        "ERR_DURABLE_RUN_ID_INVALID",
        `DurableLocal.Workflow '${String(this.resource.metadata.name)}': runId evaluated to ` +
          `${JSON.stringify(id)}; it must produce a non-empty string, since it is the key ` +
          `every record of this run is filed under.`,
        { value: id },
      );
    }
    return id;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: WorkflowManifest,
  ctx: ResourceContext,
): Promise<WorkflowController> {
  return new WorkflowController(resource, ctx);
}
