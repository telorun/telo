import {
  isCelTimestamp,
  RuntimeError,
  timestampNanos,
  type ResourceContext,
  type ResourceInstance,
  type ResourceManifest,
} from "@telorun/sdk";
import { isKvStore } from "./access-token-verification.js";
import { revoke } from "./revocation.js";

interface RevokeResource extends ResourceManifest {
  store: unknown;
}

interface RevokeInputs {
  jti: string;
  until: unknown;
}

export function register(): void {}

export async function create(resource: RevokeResource, ctx: ResourceContext): Promise<ResourceInstance> {
  const describe = `AuthBearer.Revoke "${resource.metadata.name}"`;
  return {
    async invoke(inputs: Record<string, any>) {
      const { jti, until } = inputs as RevokeInputs;
      if (!isCelTimestamp(until)) {
        throw new RuntimeError("ERR_INVALID_VALUE", `${describe}: 'until' must be a timestamp.`);
      }
      const store = ctx.resolveRef(resource.store, isKvStore, () => `${describe}: 'store'`, "KvStore.Store");
      const untilMs = Number(timestampNanos(until) / 1_000_000n);
      return { revoked: await revoke(store, jti, untilMs, Date.now()) };
    },
    snapshot() {
      return {};
    },
  };
}
