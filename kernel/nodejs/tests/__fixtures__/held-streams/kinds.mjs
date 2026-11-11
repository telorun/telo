// `Source` marks the stream it answers, so a test can tell it from a wrapper;
// `Body` answers a record counting, on the process, every time it is walked.
import { Stream } from "@telorun/sdk";

export const WALKS = Symbol.for("telo.test.heldStreamBodyWalks");

export const Source = {
  async create() {
    return {
      async invoke() {
        async function* generate() {
          yield "a";
          yield "b";
        }
        const output = new Stream(generate());
        output.producedBySource = true;
        return { output, usage: { items: 2 } };
      },
    };
  },
};

export const Body = {
  async create() {
    return {
      async invoke() {
        const rows = Array.from({ length: 10000 }, (_, i) => ({ n: i, text: "row" }));
        const body = new Proxy(
          { rows },
          {
            ownKeys(target) {
              globalThis[WALKS] = (globalThis[WALKS] ?? 0) + 1;
              return Reflect.ownKeys(target);
            },
          },
        );
        return { body };
      },
    };
  },
};
