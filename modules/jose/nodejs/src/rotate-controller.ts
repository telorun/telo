import { isJoseKeySet, type RotationOutcome } from "./key-set-contract.js";
import { operationController, type Named } from "./operation-controller.js";

interface RotateResource extends Named {
  keys: unknown;
}

export const { register, create } = operationController<RotateResource, { force?: boolean }, RotationOutcome>(
  "Jose.Rotate",
  (config, ctx, describe) => async (inputs) => {
    const keys = ctx.resolveRef(config.keys, isJoseKeySet, () => `${describe}: 'keys'`, "Jose.KeySet");
    return keys.rotate(inputs.force === true);
  },
);
