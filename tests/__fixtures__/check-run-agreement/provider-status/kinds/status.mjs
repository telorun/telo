// No `snapshot()` on either: a reported status is published on its own.
export const Endpoint = {
  async create(resource, ctx) {
    return {
      async init() {
        await ctx.setStatus({ host: "127.0.0.1", port: Number(resource.port) + 1000 });
      },
    };
  },
};

export const Listener = {
  async create(resource, ctx) {
    return {
      async run() {
        await ctx.setStatus({ port: 4000 });
      },
    };
  },
};
