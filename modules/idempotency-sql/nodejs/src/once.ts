import {
  InvokeError,
  resolveInvocableDispatcher,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { fingerprintDigest } from "./fingerprint.js";
import { isIdempotencyLedger, type IdempotencyLedger } from "./ledger.js";

interface OnceManifest {
  kind: string;
  metadata: { name: string };
  ledger?: unknown;
  invoke?: unknown;
}

interface OnceInputs {
  key: string;
  fingerprint?: unknown;
  inputs?: Record<string, unknown>;
}

interface OnceResult {
  executed: boolean;
  result?: unknown;
}

/**
 * IdempotencySql.Once — records the key in the caller's open transaction, then
 * runs the body inside it, or skips the body when the key is already recorded.
 *
 * It opens no transaction: the zone the kernel finds for the kind's root
 * requirement is the caller's, and the key is written on that zone's executor,
 * so it commits or rolls back with the body's own writes. A body that throws
 * propagates unchanged; the caller's rollback forgets the key with everything
 * else. No result is stored.
 */
class IdempotencyOnce implements ResourceInstance<OnceInputs, OnceResult> {
  constructor(
    private readonly describe: string,
    private readonly ctx: ResourceContext,
    private readonly ledger: IdempotencyLedger,
    private readonly dispatch: (
      inputs: Record<string, unknown>,
      invokeCtx?: InvokeContext,
    ) => Promise<unknown>,
  ) {}

  async invoke(inputs: OnceInputs, invokeCtx?: InvokeContext): Promise<OnceResult> {
    const zone = this.ctx.requireZone(invokeCtx);
    const outcome = await this.ledger.record(
      inputs.key,
      fingerprintDigest(inputs.fingerprint),
      zone,
      invokeCtx,
    );
    if (outcome.state === "conflict") {
      throw new InvokeError(
        "ERR_IDEMPOTENCY_KEY_CONFLICT",
        `${this.describe}: key '${inputs.key}' is already recorded in ledger ` +
          `'${this.ledger.name}' with a different fingerprint, so this call names other work ` +
          `under a key that is taken.`,
        { key: inputs.key },
      );
    }
    if (outcome.state === "duplicate") {
      // `info`: the body did NOT run, and the call still succeeds — the fact an
      // operator reconstructing a missing side effect needs.
      this.ctx.log.info("Key already recorded; the body did not run", {
        "idempotency.key": inputs.key,
        "idempotency.ledger": this.ledger.name,
      });
      return { executed: false };
    }
    const result = await this.ctx.withZone(
      "invoke",
      (zoneCtx) => this.dispatch(inputs.inputs ?? {}, zoneCtx),
      invokeCtx,
    );
    return result === undefined ? { executed: true } : { executed: true, result };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: OnceManifest,
  ctx: ResourceContext,
): Promise<IdempotencyOnce> {
  const describe = `${resource.kind} "${resource.metadata.name}"`;
  const ledger = ctx.resolveRef(
    resource.ledger,
    isIdempotencyLedger,
    () => `${describe}: 'ledger'`,
    "IdempotencySql.Ledger",
  );
  const dispatch = resolveInvocableDispatcher(resource.invoke, ctx, () => describe);
  return new IdempotencyOnce(describe, ctx, ledger, dispatch);
}
