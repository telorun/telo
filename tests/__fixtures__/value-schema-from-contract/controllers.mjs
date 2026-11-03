export const Body = {
  async create() {
    return {
      async invoke() {
        return { total: 3 };
      },
    };
  },
};

export const Once = {
  async create(resource, ctx) {
    return {
      async invoke(inputs, invokeCtx) {
        const result = await ctx.invokeResolved("", "invoke", resource.invoke, {}, invokeCtx);
        return { executed: true, result };
      },
    };
  },
};
