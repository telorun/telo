// A bundled controller, written exactly as an author would: a normal bare
// import of the SDK. The kernel's bundle loader registers a resolve hook that
// points `@telorun/sdk` at its own copy, so this resolves with no node_modules
// and no ceremony — and returns the kernel's Stream.
import { Stream } from "@telorun/sdk";

export const producer = {
  schema: { type: "object", additionalProperties: true },
  async create() {
    return {
      async invoke(inputs) {
        const text = String(inputs?.text ?? "");
        async function* gen() {
          yield Buffer.from(text, "utf8");
        }
        return { output: new Stream(gen()) };
      },
      snapshot() {
        return {};
      },
    };
  },
};
