import { InvokeError } from "@telorun/sdk";
import type { ByteEncoding, CryptoInput } from "./byte-encoding.js";
import { operationController } from "./operation-controller.js";
import { hmacSign, hmacVerify, type DigestAlgorithm } from "./primitives.js";

interface Inputs {
  op: "sign" | "verify";
  algorithm?: DigestAlgorithm;
  key: CryptoInput;
  input: CryptoInput;
  encoding?: ByteEncoding;
  expected?: string;
}

export const { register, create } = operationController<
  unknown,
  Inputs,
  { value: string } | { valid: boolean }
>((inputs) => {
  if (inputs.op === "sign") {
    return { value: hmacSign(inputs.key, inputs.input, inputs.algorithm, inputs.encoding) };
  }
  if (inputs.expected === undefined) {
    throw new InvokeError("ERR_INPUT_INVALID", "op: verify needs `expected`.", undefined, {
      inputPointer: "/expected",
    });
  }
  return {
    valid: hmacVerify(inputs.key, inputs.input, inputs.expected, inputs.algorithm, inputs.encoding),
  };
});
