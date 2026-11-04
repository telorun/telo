import { writePlainJson } from "@telorun/sdk";
import { operationController, type Named } from "./operation-controller.js";
import { seal, SEALING_PURPOSE, sealingKey } from "./sealing.js";

interface EncryptResource extends Named {
  secret: string;
}

export const { register, create } = operationController<EncryptResource, { payload: unknown }, { token: string }>(
  "Jose.Encrypt",
  (config) => {
    const key = sealingKey(config.secret, SEALING_PURPOSE);
    return async (inputs) => ({ token: await seal(writePlainJson(inputs.payload), key) });
  },
);
