import {
  InvokeError,
  SEVERITY,
  parseDurationMs,
  resolveInvocableDispatcher,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { KeyedClaim, newHolderToken, type KvStore } from "@telorun/kv-store";

interface OnceResource {
  metadata: { name: string; module?: string };
  store?: unknown;
  claimTtl: string;
  ttl: string;
  invoke?: unknown;
}

interface OnceInputs {
  key: string;
  inputs?: Record<string, unknown>;
}

interface OnceResult {
  executed: boolean;
  state: "fresh" | "replayed" | "in-flight";
  result?: unknown;
  holder?: string | null;
}

function isKvStore(value: unknown): value is KvStore {
  const candidate = value as KvStore | undefined;
  return (
    !!candidate &&
    typeof candidate.get === "function" &&
    typeof candidate.putIfAbsent === "function" &&
    typeof candidate.compareAndSet === "function" &&
    typeof candidate.compareAndDelete === "function"
  );
}

/**
 * Idempotency.Once — durable at-most-once execution.
 *
 * The claim and the "has this already run?" check are ONE atomic store operation,
 * which is the whole point: a replay-only check followed by a separate lock
 * reopens the window this kind exists to close. The claim protocol itself lives in
 * `KeyedClaim` over a plain `KvStore`, so no backend reimplements it.
 *
 * Failure is never settled. A body that throws releases the key so the operation
 * stays retryable, and the error propagates untouched — a swallowed failure here
 * would look exactly like a success that can never be retried.
 */
class IdempotencyOnce implements ResourceInstance<OnceInputs, OnceResult> {
  private readonly claimTtlMs: number;
  private readonly ttlMs: number;

  constructor(
    private readonly resource: OnceResource,
    private readonly ctx: ResourceContext,
  ) {
    this.claimTtlMs = parseDurationMs(resource.claimTtl);
    this.ttlMs = parseDurationMs(resource.ttl);
  }

  // A missing or empty `key` is rejected by the declared `inputType`
  // (`required: [key]`, `minLength: 1`) before this runs — the kernel binds the
  // contract to this instance and validates every call. The guard used to live
  // here because nothing enforced the contract; keeping it now would double-check
  // the same condition and shadow the kernel's message, which names the target
  // and the offending value.
  async invoke(inputs: OnceInputs, invokeCtx?: InvokeContext): Promise<OnceResult> {
    const name = this.resource.metadata.name;

    const store = this.ctx.resolveRef(
      this.resource.store,
      isKvStore,
      () => `Idempotency.Once "${name}": 'store'`,
      "KvStore.Store",
    );
    const claims = new KeyedClaim(store);
    const holder = newHolderToken();
    const claim = await claims.claim(inputs.key, holder, this.claimTtlMs);

    // `info` on both suppressed paths: the body did NOT run, which is the fact an
    // operator reconstructing "why is there no side effect for this request"
    // needs. Both return a successful result, so nothing else marks them.
    if (claim.state === "settled") {
      this.ctx.log.info("Replayed a settled result; the body did not run", {
        "idempotency.key": inputs.key,
      });
      return { executed: false, state: "replayed", result: claim.value };
    }
    if (claim.state === "held") {
      this.ctx.log.info("Key is claimed by another caller still in flight; the body did not run", {
        "idempotency.key": inputs.key,
        "idempotency.holder": String(claim.holder ?? ""),
      });
      return { executed: false, state: "in-flight", holder: claim.holder ?? null };
    }

    const dispatch = resolveInvocableDispatcher(
      this.resource.invoke,
      this.ctx,
      () => `Idempotency.Once "${name}"`,
    );

    // The revision advances on every renew, and each conditional write must
    // present the CURRENT one — so the heartbeat threads it forward rather than
    // holding the version the claim returned.
    let version = claim.version!;

    // Keep the claim alive while a long body runs, so `claimTtl` bounds a DEAD
    // holder rather than a slow one. Half the window gives one missed beat of
    // slack before it lapses.
    const heartbeat = setInterval(() => {
      void claims
        .renew(inputs.key, version, this.claimTtlMs)
        .then((renewed) => {
          if (renewed?.version) version = renewed.version;
        })
        .catch((err: unknown) => {
          // A failed renew is not fatal on its own — the claim simply lapses on
          // schedule and another caller may take over, and the body's own outcome
          // still decides settle-vs-release below.
          //
          // `warn` nonetheless: a failing renew is a STORE WRITE failing, which
          // is an infrastructure fault, and it is the leading indicator of the
          // `ERR_CLAIM_LOST` this kind raises later. At `debug` it would only be
          // captured by someone who had already raised the level before the
          // incident — and by the time anyone is diagnosing the lost claim, the
          // store failure that caused it is long gone.
          this.ctx.log.warn(
            "Claim heartbeat failed; the claim will lapse on schedule unless a later beat succeeds",
            { "idempotency.key": inputs.key },
            { error: err },
          );
        });
    }, Math.max(1, Math.floor(this.claimTtlMs / 2)));
    // Never hold the process open for a heartbeat alone.
    heartbeat.unref?.();

    // The body and the settlement are separate failure domains, and conflating
    // them is a correctness bug, not a style choice. Inside one try, a store
    // failure DURING settlement would run the catch — releasing the key after the
    // side effect already happened, so the next call re-runs the body. That is
    // precisely the double execution this kind exists to prevent.
    let result: unknown;
    try {
      // The claim is what makes this region genuinely re-runnable, so the zone
      // it opens EARNS its `idempotent` attribute rather than asserting it: a
      // second pass finds the settled result and replays it. A consumer reading
      // the ambient stack (a durable step engine deciding collapse) sees that,
      // and sees `noSuspend` beside it — the claim is renewed on a heartbeat
      // only while this process runs the body.
      result = await this.ctx.withZone(
        "invoke",
        (zoneCtx) => dispatch(inputs.inputs ?? {}, zoneCtx),
        invokeCtx,
      );
    } catch (err) {
      // The body failed, so nothing happened that must not happen twice: free the
      // key and let the caller retry. The error propagates untouched.
      await claims.release(inputs.key, version);
      if (this.ctx.log.enabled(SEVERITY.debug)) {
        // The error itself reaches the caller; what does not is that the key was
        // freed, which is why an immediate retry is admitted rather than replayed.
        this.ctx.log.debug("Body failed; released the claim so the operation stays retryable", {
          "idempotency.key": inputs.key,
        });
      }
      throw err;
    } finally {
      clearInterval(heartbeat);
    }

    // From here the side effect HAS happened. The key is never released on this
    // path: if recording the outcome fails, the claim simply lapses on
    // `claimTtl`, which is the correct end state — the work is done, the record
    // is not, and no retry may re-run the body inside the claim window.
    const settled = await claims.settle(inputs.key, version, holder, result, this.ttlMs);
    if (!settled) {
      // The claim was lost mid-body (it lapsed and someone else took the key, or
      // a renew failed long enough for it to expire). The result is NOT
      // persisted, so a later call will re-run the body — the guarantee is
      // already broken and the caller must hear about it rather than receive a
      // `fresh` that implies a durable record.
      //
      // Logged as well as thrown: this is the at-most-once guarantee breaking,
      // and whether it stays visible must not depend on what the caller does with
      // the error — a route's `catches:` can map it to a response and leave no
      // other record that the key may now run twice.
      this.ctx.log.error("Claim was lost after the body ran; the result could not be recorded", {
        "idempotency.key": inputs.key,
      });
      throw new InvokeError(
        "ERR_CLAIM_LOST",
        `Idempotency.Once "${name}": the body ran but its claim on key "${inputs.key}" was no ` +
          `longer held, so the result could not be recorded — a later call may run it again. ` +
          `Raise \`claimTtl\` above the body's worst-case duration.`,
      );
    }
    if (this.ctx.log.enabled(SEVERITY.debug)) {
      this.ctx.log.debug("Body ran and its result was recorded", {
        "idempotency.key": inputs.key,
      });
    }
    return { executed: true, state: "fresh", result };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const once = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: OnceResource, ctx: ResourceContext) {
    return new IdempotencyOnce(resource, ctx);
  },
};
