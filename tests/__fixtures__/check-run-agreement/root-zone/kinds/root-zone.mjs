export const Holder = {
  async create() {
    return {};
  },
};

export const Guarded = {
  async create(resource, ctx) {
    return {
      async invoke(inputs, invokeCtx) {
        ctx.requireZone(invokeCtx);
        return {};
      },
    };
  },
};
