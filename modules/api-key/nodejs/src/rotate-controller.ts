import { durationMs, InvokeError, type CelDuration, type CelTimestamp, type InvokeContext, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { mintKey, publicIdOf } from "./key-format.js";
import { durationOfMillis } from "./instants.js";
import {
  BoundKeyOperation,
  ERR_API_KEY_REVOKED,
  issuedRecord,
  optionalTimestamp,
  type OperationResource,
} from "./key-operation.js";
import { storeInconsistent } from "./store-failure.js";

interface RotateInputs {
  id: string;
  overlap?: CelDuration;
  expiresAt?: CelTimestamp | null;
}

/** ApiKey.Rotate — issue a successor with the same owner and scopes and cap the old key's expiry at now + overlap, in one store call. */
class Rotate implements ResourceInstance<RotateInputs, Record<string, unknown>> {
  constructor(private readonly bound: BoundKeyOperation) {}

  async invoke(inputs: RotateInputs, invokeCtx?: InvokeContext): Promise<Record<string, unknown>> {
    const uuid = this.bound.uuidOf(inputs.id);
    const store = this.bound.store;
    const settings = store.settings();
    const expiresAt = optionalTimestamp(inputs.expiresAt, this.bound.describe, "expiresAt");
    this.bound.checkLifetime(expiresAt, settings, Date.now());
    const overlapMs = inputs.overlap === undefined ? 0 : durationMs(inputs.overlap);
    if (overlapMs === undefined || overlapMs < 0) {
      throw new InvokeError("ERR_INPUT_INVALID", `${this.bound.describe}: 'overlap' must be a non-negative duration.`);
    }

    const minted = mintKey(settings.prefix);
    const outcome = await this.bound.call(() =>
      store.rotate(
        { id: uuid, successor: { id: minted.uuid, digest: minted.digest, expiresAt }, overlap: durationOfMillis(overlapMs) },
        invokeCtx,
      ),
    );
    switch (outcome.outcome) {
      case "rotated":
        return {
          key: minted.key,
          ...issuedRecord(outcome.successor),
          previous: { id: publicIdOf(outcome.predecessor.id), expiresAt: outcome.predecessor.expiresAt },
        };
      case "revoked":
        throw new InvokeError(ERR_API_KEY_REVOKED, `${this.bound.describe}: the key "${inputs.id}" is revoked and cannot be rotated.`);
      case "absent":
        throw this.bound.notFound(inputs.id);
      default:
        throw storeInconsistent(this.bound.describe, `${JSON.stringify(outcome)} for a rotation`);
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<Rotate> {
  return new Rotate(new BoundKeyOperation("ApiKey.Rotate", resource, ctx));
}

export function register(): void {}
