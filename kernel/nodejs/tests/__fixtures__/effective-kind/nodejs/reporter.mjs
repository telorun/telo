// Reports its observed state `times` times from `init()`.
export const reporter = {
  async create(resource, ctx) {
    return {
      async init() {
        for (let count = 1; count <= resource.times; count++) await ctx.setStatus({ count });
      },
    };
  },
};

// Returns its inputs as its output.
export const echo = {
  async create() {
    return { async invoke(inputs) { return inputs; } };
  },
};
