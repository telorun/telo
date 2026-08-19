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
  deriveContext,
  isCancellationError,
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

/** How long this instance owns a run it took over from a dead holder. Bounded
 *  for the reason every claim in this repo is: a process that dies must free the
 *  run rather than wedge it. */
const CLAIM_TTL_MS = 60_000;

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
        return { runId, replayed: true, result: existing.result };
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
        return { runId, replayed: true, running: true };
      }
    }

    return this.execute(runId, journal, cel, invokeCtx);
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
  ): Promise<unknown> {
    const handle = await LocalRunHandle.open(runId, journal);

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

    const result = { steps };
    await journal.completeRun(runId, { status: "completed", result });
    // What the run learned about itself, carried in the OUTCOME.
    //
    // It belongs in observed state — it is a reading, not something the author
    // configured — and it will move there. It cannot live there yet: the kernel
    // marks a resource started only for a `run()` dispatch, so a Telo.Invocable
    // reporting observed state is rejected before it has said anything.
    //
    // `collapsedRegions` is the one an operator needs, because whether a
    // deployment got exactly-once or at-least-once turns on whether the
    // journal's writes land inside the transaction's atomicity — invisible in
    // the manifest, and silently degrading if someone repoints the journal.
    // `collapseReasons` carries the AUTHOR's sentence for each, so the answer to
    // "why is this at-least-once" is the manifest's own words.
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
