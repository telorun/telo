import { operationController, type Named } from "./operation-controller.js";
import { SEALING_PURPOSE, sealingKey, unseal, type UnsealRefusal } from "./sealing.js";

interface DecryptResource extends Named {
  secret: string;
  previousSecrets?: string[];
}

type Decrypted = { valid: true; payload: unknown } | { valid: false; reason: UnsealRefusal };

export const { register, create } = operationController<DecryptResource, { token: string }, Decrypted>(
  "Jose.Decrypt",
  (config) => {
    const keys = [config.secret, ...(config.previousSecrets ?? [])].map((secret) =>
      sealingKey(secret, SEALING_PURPOSE),
    );
    return async (inputs) => {
      const opened = await unseal(inputs.token, keys);
      if (!opened.ok) return { valid: false, reason: opened.reason };
      let payload: unknown;
      try {
        payload = JSON.parse(opened.plaintext);
      } catch {
        return { valid: false, reason: "malformed" };
      }
      return { valid: true, payload };
    };
  },
);
