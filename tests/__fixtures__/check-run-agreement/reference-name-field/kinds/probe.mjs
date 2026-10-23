// `Named` answers with the `name` field it was declared with; `Holder` invokes
// the resource its `target` slot holds and answers with what it returned.
export const Named = {
  async create(resource) {
    return { invoke: async () => ({ name: resource.name }) };
  },
};

const isInvocable = (candidate) => typeof candidate?.invoke === "function";

export const Holder = {
  async create(resource, ctx) {
    return {
      invoke: async () =>
        ctx.resolveRef(resource.target, isInvocable, () => "'target'", "Telo.Invocable").invoke({}),
    };
  },
};
