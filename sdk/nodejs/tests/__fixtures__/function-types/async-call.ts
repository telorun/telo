// A function controller whose `call` is async: the SDK's types must refuse it.
import type { FunctionController } from "../../../src/function-controller.js";

interface Args extends Record<string, unknown> {
  key: string;
}

export const Hmac: FunctionController<{ kind: string; metadata: { name: string } }, Args, string> = {
  async create() {
    return {
      call: async ({ key }: Args) => key,
    };
  },
};
