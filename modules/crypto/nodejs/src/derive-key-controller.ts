import { integerInput } from "@telorun/sdk";
import type { ByteEncoding, CryptoInput } from "./byte-encoding.js";
import { operationController } from "./operation-controller.js";
import { deriveKey, type DigestAlgorithm } from "./primitives.js";

interface Inputs {
  secret: CryptoInput;
  salt?: CryptoInput;
  info?: CryptoInput;
  length?: unknown;
  hash?: DigestAlgorithm;
  encoding?: ByteEncoding;
}

export const { register, create } = operationController<unknown, Inputs, { key: string }>(
  (inputs) => ({
    key: deriveKey(inputs.secret, {
      salt: inputs.salt,
      info: inputs.info,
      length: inputs.length === undefined ? undefined : (integerInput(inputs.length) ?? NaN),
      hash: inputs.hash,
      encoding: inputs.encoding,
    }),
  }),
);
