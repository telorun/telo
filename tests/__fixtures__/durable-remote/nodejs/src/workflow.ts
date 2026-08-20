/**
 * A durable backend that ships every step to a CHILD KERNEL.
 *
 * It exists to hold the remote half of the step seam under load before a hosted
 * engine does. `step()` takes a declaration-site identity precisely so a backend
 * can execute a step somewhere the instance does not exist — and until something
 * actually sends one, that parameter is a claim nothing tests. A child kernel is
 * a real boundary: it shares no instance graph with this process, so a target
 * that does not genuinely survive encoding cannot resolve there by accident.
 *
 * Its crudeness is the point. What it can fail at is exactly what slice 7 would
 * otherwise be the first to discover — an identity that does not survive being
 * written down — for a fraction of the cost of a hosted engine.
 *
 * **What it deliberately is NOT.** There is no journal here and no recovery: a
 * run's records live in a map that dies with the process. Crash recovery is
 * proven by `durable-local` against a real store; re-proving it here would make
 * the fixture a second backend to maintain rather than one seam under test.
 */
import {
  StepEngine,
  decodeDurableTarget,
  deriveContext,
  encodeDurableTarget,
  type DurableDecisionKind,
  type DurableRunHandle,
  type DurableTarget,
  type InvokeContext,
  type ResourceContext,
  type ResourceManifest,
  type Step,
  type ZoneEntry,
} from "@telorun/sdk";

interface RemoteWorkflowManifest extends ResourceManifest {
  dispatcher: string;
  steps: Step[];
  inputs?: Record<string, unknown>;
}

/** The zone this backend provides, by the kind that provides it. A step whose
 *  dispatch sits inside any OTHER open zone must execute locally — a zone is
 *  ambient process state (an open transaction, a held lease) and a child kernel
 *  holds none of it. */
const OWN_ZONE = "DurableRemote.Workflow";

class RemoteRunHandle implements DurableRunHandle {
  readonly #recorded = new Map<string, unknown>();
  /** Step paths that genuinely crossed the boundary, so the test can assert the
   *  seam was used rather than infer it from a result. */
  readonly shipped: string[] = [];

  constructor(
    readonly runId: string,
    private readonly ctx: ResourceContext,
    private readonly dispatcher: string,
  ) {}

  async step(
    path: string,
    target: DurableTarget | undefined,
    inputs: unknown,
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    if (this.#recorded.has(path)) return this.#recorded.get(path);

    // LOCALITY IS DECIDED BY ZONES, not by a list of exceptions. Any open zone
    // other than this backend's own means ambient process state the child does
    // not have, and running there would silently execute unzoned — which the
    // payload rule says must fail loudly instead.
    const zones = this.ctx.zoneAttributes?.() ?? [];
    const foreignZone = zones.find((zone) => zone.kind !== OWN_ZONE);
    // A target with no declaration-site identity cannot be named anywhere else.
    // A local backend runs it; a RELOCATING one refuses rather than guessing,
    // and the honest form of that here is to keep it in process and say so.
    if (foreignZone || !target) {
      const result = await execute();
      this.#recorded.set(path, result);
      return result;
    }

    const result = await this.shipStep(path, target, inputs);
    this.#recorded.set(path, result);
    return result;
  }

  /**
   * Run one step in a child kernel, addressed by its identity alone.
   *
   * The identity is ALL the child receives — no instance, no reference, no
   * shared graph — which is what makes this a test of the encoding rather than
   * of a lookup.
   */
  private async shipStep(path: string, target: DurableTarget, inputs: unknown): Promise<unknown> {
    const child = await this.ctx.runtime.run(this.dispatcher, {
      env: {
        ...this.ctx.env,
        TELO_STEP_TARGET: encodeDurableTarget(target),
        TELO_STEP_INPUTS: JSON.stringify(inputs ?? {}),
      },
    });
    // Both streams are drained: a child nobody reads accumulates in this
    // process's memory, and the failure text is the only thing that explains a
    // non-zero exit.
    const [out, err, code] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      child.exitCode,
    ]);
    if (code !== 0) {
      throw new Error(
        `Remote step '${path}' failed in the child kernel (exit ${code}): ${err.trim() || out.trim()}`,
      );
    }
    const line = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .pop();
    if (!line) {
      throw new Error(`Remote step '${path}' produced no result line. Output was: ${out}`);
    }
    this.shipped.push(path);
    return JSON.parse(line);
  }

  async decide<T>(path: string, _kind: DurableDecisionKind, compute: () => T): Promise<T> {
    if (this.#recorded.has(path)) return this.#recorded.get(path) as T;
    const value = await compute();
    this.#recorded.set(path, value);
    return value;
  }

  async park(): Promise<never> {
    throw new Error("DurableRemote.Workflow does not implement waiting — see durable-local.");
  }

  writesInside(_zone: ZoneEntry): boolean {
    // Nothing is journaled here, so there is nothing for a transaction to be
    // holding. Answering false is what gets the ordinary collapse, and it is
    // correct rather than a placeholder.
    return false;
  }
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

export class RemoteWorkflowController {
  private readonly engine: StepEngine;
  #dispatcher: string | undefined;

  constructor(
    private readonly resource: RemoteWorkflowManifest,
    private readonly ctx: ResourceContext,
  ) {
    this.engine = new StepEngine(ctx, {
      kind: "Workflow",
      resourceName: String(resource.metadata.name),
    });
  }

  async init(): Promise<void> {
    // Reached the one way a module file ever is — never by deriving a directory
    // from the module source, which for a published module is not where the
    // payload lives.
    this.#dispatcher = await this.ctx.resolveModuleFile(this.resource.dispatcher);
  }

  async invoke(inputs: unknown, invokeCtx?: InvokeContext): Promise<unknown> {
    const handle = new RemoteRunHandle(`remote:${Date.now()}`, this.ctx, this.#dispatcher!);
    const steps: Record<string, unknown> = {};
    // The body starts outside every enclosing zone — a run outlives whatever
    // triggered it — and the workflow's own zone plus the handle are layered
    // onto that root rather than onto the caller's context.
    const root = this.ctx.rootContext();
    const durable = deriveContext(root, { durable: handle });
    await this.ctx.withZone(
      "steps",
      (zoneCtx) =>
        this.engine.executeSteps(this.resource.steps, steps, undefined, { inputs }, zoneCtx),
      durable,
    );
    return { steps, shipped: handle.shipped };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: RemoteWorkflowManifest,
  ctx: ResourceContext,
): Promise<RemoteWorkflowController> {
  return new RemoteWorkflowController(resource, ctx);
}

/** Re-exported so the dispatcher's own controller reads targets through the same
 *  function that wrote them — a fixture that decoded with its own parser would
 *  be testing two implementations agreeing rather than one round-tripping. */
export { decodeDurableTarget };
