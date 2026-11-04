import { integerInput } from "@telorun/sdk";
import type { ByteEncoding } from "./byte-encoding.js";
import { operationController } from "./operation-controller.js";
import { randomValue } from "./primitives.js";

interface Inputs {
  bytes?: unknown;
  encoding?: ByteEncoding;
}

const controller = operationController<unknown, Inputs, { value: string }>((inputs) => ({
  value: randomValue(
    inputs.bytes === undefined ? undefined : (integerInput(inputs.bytes) ?? NaN),
    inputs.encoding,
  ),
}));
export const { register, create } = controller;
