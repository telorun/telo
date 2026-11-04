import type { InvokeContext } from "@telorun/sdk";
import { isJoseKeys, type JsonWebKeySet } from "./key-set-contract.js";
import { operationController, type Named } from "./operation-controller.js";

interface PublicKeysResource extends Named {
  keys: unknown;
}

export const { register, create } = operationController<PublicKeysResource, unknown, JsonWebKeySet>(
  "Jose.PublicKeys",
  (config, ctx, describe) => async (inputs: unknown, invokeCtx?: InvokeContext) => {
    const keys = ctx.resolveRef(config.keys, isJoseKeys, () => `${describe}: 'keys'`, "Jose.Keys");
    return keys.publicKeys(invokeCtx?.cancellation.signal);
  },
);
