import {
  InvokeError,
  parseDurationMs,
  resolveInvocableDispatcher,
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

  async invoke(inputs: OnceInputs): Promise<OnceResult> {
    const name = this.resource.metadata.name;
    if (!inputs || typeof inputs.key !== "string" || inputs.key.length === 0) {
      // An empty key must not collapse every caller onto one key, which would
      // suppress unrelated operations as "already done". Reporting `in-flight`
      // would be a lie the caller cannot act on — nothing holds the key, so it
      // would retry forever against a condition that never clears.
      throw new InvokeError(
        "ERR_INVALID_KEY",
        `Idempotency.Once "${name}": \`key\` must be a non-empty string. It identifies the ` +
          `operation, so an empty key would merge unrelated calls onto one record. Supply a ` +
          `deterministic id (a request id, an order id).`,
      );
    }

    const store = this.ctx.resolveRef(
      this.resource.store,
      isKvStore,
      () => `Idempotency.Once "${name}": 'store'`,
      "std/kv-store#Store",
    );
    const claims = new KeyedClaim(store);
    const holder = newHolderToken();
    const claim = await claims.claim(inputs.key, holder, this.claimTtlMs);

    if (claim.state === "settled") {
      return { executed: false, state: "replayed", result: claim.value };
    }
    if (claim.state === "held") {
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
        .catch(() => {
          // A failed renew is not fatal on its own — the claim simply lapses on
          // schedule and another caller may take over. The body's own outcome
          // still decides settle-vs-release below.
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
      result = await dispatch(inputs.inputs ?? {});
    } catch (err) {
      // The body failed, so nothing happened that must not happen twice: free the
      // key and let the caller retry. The error propagates untouched.
      await claims.release(inputs.key, version);
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
      throw new InvokeError(
        "ERR_CLAIM_LOST",
        `Idempotency.Once "${name}": the body ran but its claim on key "${inputs.key}" was no ` +
          `longer held, so the result could not be recorded — a later call may run it again. ` +
          `Raise \`claimTtl\` above the body's worst-case duration.`,
      );
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
