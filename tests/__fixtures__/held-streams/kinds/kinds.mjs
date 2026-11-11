// Stream sources bound to their resource's lifetime: a pull after teardown fails.
import { Stream } from "@telorun/sdk";

function lifetime(ctx) {
  const state = { tornDown: false };
  const init = () =>
    ctx.effect("held stream fixture", async () => ({
      result: undefined,
      inverse: async () => {
        state.tornDown = true;
      },
    }));
  const guard = (what) => {
    if (state.tornDown) throw new Error(`${what} pulled after its resource was torn down`);
  };
  return { init, guard };
}

function items(count, prefix, guard) {
  async function* generate() {
    for (let i = 0; i < count; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      guard(prefix);
      yield `${prefix}-${i}`;
    }
  }
  return new Stream(generate());
}

export const Source = {
  async create(resource, ctx) {
    const { init, guard } = lifetime(ctx);
    const count = Number(resource.items ?? 3);
    return {
      init,
      async invoke() {
        return { output: items(count, "item", guard), usage: { items: count } };
      },
    };
  },
};

export const Parts = {
  async create(resource, ctx) {
    const { init, guard } = lifetime(ctx);
    const count = Number(resource.parts ?? 2);
    return {
      init,
      async invoke() {
        async function* parts() {
          for (let i = 0; i < count; i++) {
            guard("part");
            yield { name: `part-${i}`, content: items(2, `part-${i}`, guard) };
          }
        }
        return { parts: new Stream(parts()) };
      },
    };
  },
};
