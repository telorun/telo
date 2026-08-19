/**
 * `DurableLocal.Deliver` — wake a parked run with the value it was waiting for.
 *
 * The delivering half of `Durable.Await`, and NATIVE by design: waking a run is
 * a journal write here, an awakeable resolution on Restate and a signal on
 * Temporal. A shared deliver kind would have put the half of the lifecycle where
 * engines differ most back into a common contract.
 *
 * **The payload is written at the park's own step path, which makes it the
 * step's result.** There is no second key to reconcile: the step engine wrapped
 * the await's dispatch in `step(path, …)`, so a replay finds this entry at that
 * path and returns it without the await ever being reached again. That is the
 * whole wake mechanism, and it is why nothing here has to understand what the
 * body was doing.
 *
 * It does NOT continue the run. The resumer does, on its next pass — which is
 * what lets a delivery arrive in a different process from the one that will
 * execute the rest of the body, days later.
 *
 * **The payload is validated HERE, and here is the only place it can be.** A
 * delivered value enters the run's record without ever being dispatched — a
 * replay hands it back as the wait's result rather than re-entering the wait —
 * so the invocation contract never sees it. Every other journaled value was
 * checked when it was produced; this one is produced by a caller outside the
 * run, which makes this the moment it is produced. Checking at the delivery is
 * also where it is actionable: the caller who sent the wrong shape is still on
 * the phone.
 */
import {
  InvokeError,
  type DataValidator,
  type InvokeContext,
  type ResourceContext,
  type ResourceManifest,
} from "@telorun/sdk";
import { journalOf } from "./journal-ref.js";

interface DeliverManifest extends ResourceManifest {
  journal: unknown;
  await?: unknown;
  token?: string;
  payload?: unknown;
}

class DeliverController {
  /** Compiled from the named wait's own declared shape, once. Lazy rather than
   *  built in `create()`, because the reference is a live instance only after
   *  the kernel has injected it. */
  #validator: DataValidator | null | undefined;

  constructor(
    private readonly resource: DeliverManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {}

  async invoke(input: unknown, _invokeCtx?: InvokeContext): Promise<unknown> {
    const name = String(this.resource.metadata.name);
    const cel = { inputs: input ?? {} };
    const token = String(this.ctx.expandValue(this.resource.token, cel) ?? "");
    if (!token) {
      throw new InvokeError(
        "ERR_DURABLE_TOKEN_REQUIRED",
        `DurableLocal.Deliver '${name}': 'token' evaluated to nothing. A delivery is ` +
          `addressed by the token the await minted; without one there is no run to wake.`,
        { resource: name },
      );
    }

    // CHECKED BEFORE THE LOOKUP. A payload of the wrong shape is the caller's
    // error whether or not anything is waiting on the token, and checking after
    // the lookup would make the diagnostic depend on a race — deliver twice and
    // the second call, finding the token spent, would report success for a
    // payload the first call would have rejected.
    const payload = this.ctx.expandValue(this.resource.payload ?? null, cel);
    this.validate(payload, name, token);

    const journal = journalOf(this.ctx, this.resource.journal, `DurableLocal.Deliver "${name}"`);
    const parked = await journal.runParkedOn(token);
    // A token that matches no parked run is REPORTED, not raised. Stale,
    // already-delivered and simply-wrong are one answer to a caller, and every
    // one of them is an ordinary outcome of a public endpoint that accepts a
    // token from outside — an approval clicked twice is not an error to page on.
    if (!parked) return { delivered: false };

    // First writer wins at a path, so two deliveries racing on one token settle
    // on one payload rather than the run seeing whichever landed last.
    await journal.append(parked.run, {
      path: parked.park.path,
      kind: "step",
      value: payload,
    });
    await journal.unparkRun(parked.run);
    return { delivered: true, run: parked.run };
  }

  /**
   * Check the payload against the shape the named wait declared.
   *
   * A delivery that names no wait is unchecked, and that is a property of the
   * manifest rather than a gap: a token addressed from outside — from an email
   * link, a webhook, an operator — has no declaration to check against. Naming
   * the wait is what opts into both halves, the static check on a literal
   * payload and this one on the value actually sent.
   */
  private validate(payload: unknown, name: string, token: string): void {
    if (this.#validator === undefined) {
      const declared = (this.resource.await as { resource?: { outputType?: unknown } } | undefined)
        ?.resource?.outputType as { schema?: unknown } | undefined;
      const schema = declared?.schema ?? declared;
      this.#validator = schema ? this.ctx.createTypeValidator(schema as never) : null;
    }
    if (!this.#validator) return;
    try {
      this.#validator.validate(payload);
    } catch (err) {
      throw new InvokeError(
        "ERR_DURABLE_PAYLOAD_INVALID",
        `DurableLocal.Deliver '${name}': the payload does not match the shape the wait it ` +
          `names declares (${(err as Error).message}). It is checked here because a ` +
          `delivered value enters the record without being dispatched, so nothing ` +
          `downstream would have looked at it — the work would simply have read the ` +
          `wrong shape.`,
        { resource: name, token },
        { cause: err },
      );
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: DeliverManifest,
  ctx: ResourceContext,
): Promise<DeliverController> {
  return new DeliverController(resource, ctx);
}
