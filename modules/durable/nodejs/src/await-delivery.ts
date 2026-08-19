/**
 * `Durable.Await` — park until something outside the run delivers a value.
 *
 * It **names nothing**, and the delivering side is native. There is no shared
 * `Durable.Deliver` to pair with it: waking a run is a `DurableLocal.Deliver`, a
 * Restate awakeable resolution or a Temporal signal, and those are genuinely
 * different operations. What is shared is the waiting half, which talks to
 * nothing but the run handle.
 *
 * **The token is journaled, so it survives the process that minted it.** An
 * await whose token were re-minted on resume would hand out an address nobody
 * holds, and the delivery sent to the first one would never arrive.
 *
 * **The delivered payload is the enclosing step's own entry**, which is why
 * nothing here reads it back. The step engine has already opened
 * `step(path, …)` around this dispatch, so a delivery recorded at that path is
 * what a replay returns — the await is simply not reached again.
 */
import {
  InvokeError,
  parseDurationMs,
  parkRun,
  assertMaySuspend,
  stepPath,
  type InvokeContext,
  type ResourceContext,
  type ResourceManifest,
} from "@telorun/sdk";
import { recordPath, requireRun } from "./ambient-run.js";

interface AwaitManifest extends ResourceManifest {
  token?: string;
  timeout?: string;
  outputType?: unknown;
}

class AwaitController {
  constructor(
    private readonly resource: AwaitManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {}

  async invoke(input: unknown, invokeCtx?: InvokeContext): Promise<unknown> {
    const name = String(this.resource.metadata.name);
    const handle = requireRun(invokeCtx, "Durable.Await", name);
    const path = recordPath(invokeCtx, name);

    // AUTHORED or minted, and journaled either way. Journaling matters for both:
    // a minted token re-minted on resume would hand out an address nobody holds,
    // and an authored one is CEL over the call's inputs, which a resume has no
    // call to re-derive from.
    //
    // Authoring one is what makes the address knowable BEFORE the run parks —
    // an approval email has to carry the link, and a step that sends it runs
    // before the wait. Minting covers the other case, where the token is handed
    // out by something that reads the run rather than by the run itself.
    const token = (await handle.decide(stepPath(path, "token"), "value", () =>
      this.resource.token === undefined
        ? crypto.randomUUID()
        : String(this.ctx.expandValue(this.resource.token, { inputs: input ?? {} })),
    )) as string;

    // THE DEADLINE IS PINNED, exactly as `Durable.Sleep` pins its wake time, and
    // for a sharper reason: a deadline recomputed from `now()` on every resume
    // slides forward by however long each wait lasted, so a 72-hour timeout is
    // never reached and `timeout:` silently means nothing at all.
    const timeout = this.timeoutMs(input);
    const deadline =
      timeout === undefined
        ? undefined
        : ((await handle.decide(stepPath(path, "deadline"), "value", () =>
            Date.now() + timeout,
          )) as number);

    // The deadline having passed is how a timeout FIRES. This is the re-entry
    // after the run was picked up because it came due with nothing delivered:
    // a delivery would have been recorded at this step's own path, so the await
    // would not have been reached at all. Raised rather than returned, because
    // an author who declared a deadline declared that not being answered is a
    // failure — returning some empty value would hand the steps after it a
    // result that looks like an answer.
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new InvokeError(
        "ERR_DURABLE_AWAIT_TIMEOUT",
        `Durable.Await '${name}' waited until its deadline without a delivery. Nothing ` +
          `delivered to token '${token}' in time.`,
        { resource: name, token, deadline },
      );
    }

    assertMaySuspend(this.ctx, invokeCtx, { resource: name });

    return parkRun(
      handle,
      { path, resource: name },
      deadline === undefined ? { token } : { token, at: deadline },
    );
  }

  /** A deadline is per CALL as well as per instance: `inputs.timeout` lets one
   *  await serve two step sites that wait different lengths, which is the shape
   *  the plan's own example uses. */
  private timeoutMs(input: unknown): number | undefined {
    const fromCall = (input as { timeout?: unknown } | undefined)?.timeout;
    const raw = fromCall ?? this.resource.timeout;
    if (raw === undefined) return undefined;
    return parseDurationMs(String(raw));
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: AwaitManifest,
  ctx: ResourceContext,
): Promise<AwaitController> {
  return new AwaitController(resource, ctx);
}
