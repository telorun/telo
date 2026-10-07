const isInvocable = (candidate) => typeof candidate?.invoke === "function";

export const Chosen = {
  async create(resource, ctx) {
    return {
      async invoke(inputs) {
        const entries = Array.isArray(resource.target) ? resource.target : [{ target: resource.target }];
        const chosen = entries.find(
          (entry) => entry.when === undefined || ctx.expandValue(entry.when, { inputs }) === true,
        );
        return {
          injected: isInvocable(chosen.target),
          result: await chosen.target.invoke({}),
        };
      },
    };
  },
};
