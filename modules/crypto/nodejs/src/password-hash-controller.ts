import { InvokeError } from "@telorun/sdk";
import type { CryptoInput } from "./byte-encoding.js";
import { operationController } from "./operation-controller.js";
import {
  hashPassword,
  verifyPassword,
  type PasswordPolicy,
  type PasswordVerdict,
} from "./password-hash.js";

interface Inputs {
  op: "hash" | "verify";
  password: CryptoInput;
  hash?: string;
}

export const { register, create } = operationController<
  PasswordPolicy,
  Inputs,
  { hash: string } | PasswordVerdict
>(async (inputs, config) => {
  const policy: PasswordPolicy = {
    algorithm: config.algorithm ?? "argon2id",
    parameters: config.parameters,
    pepper: config.pepper,
  };
  if (inputs.op === "hash") return { hash: await hashPassword(inputs.password, policy) };
  if (inputs.hash === undefined) {
    throw new InvokeError("ERR_INPUT_INVALID", "op: verify needs `hash`.", undefined, {
      inputPointer: "/hash",
    });
  }
  return verifyPassword(inputs.password, inputs.hash, policy);
});
