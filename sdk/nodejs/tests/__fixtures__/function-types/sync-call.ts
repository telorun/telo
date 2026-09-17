// A function controller whose `call` is synchronous — async setup in `create` is
// fine.
import type { FunctionController } from "../../../src/function-controller.js";

interface Args extends Record<string, unknown> {
  key: string;
}

export const Hmac: FunctionController<{ kind: string; metadata: { name: string } }, Args, string> = {
  async create() {
    return {
      call: ({ key }: Args) => key,
    };
  },
};
