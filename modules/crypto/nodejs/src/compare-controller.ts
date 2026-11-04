import type { CryptoInput } from "./byte-encoding.js";
import { operationController } from "./operation-controller.js";
import { constantTimeEqual } from "./primitives.js";

export const { register, create } = operationController<
  unknown,
  { a: CryptoInput; b: CryptoInput },
  { equal: boolean }
>((inputs) => ({ equal: constantTimeEqual(inputs.a, inputs.b) }));
