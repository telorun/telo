import type { ByteEncoding, CryptoInput } from "./byte-encoding.js";
import { operationController } from "./operation-controller.js";
import { digest, type DigestAlgorithm } from "./primitives.js";

interface Inputs {
  algorithm?: DigestAlgorithm;
  input: CryptoInput;
  encoding?: ByteEncoding;
}

export const { register, create } = operationController<unknown, Inputs, { value: string }>(
  (inputs) => ({ value: digest(inputs.input, inputs.algorithm, inputs.encoding) }),
);
