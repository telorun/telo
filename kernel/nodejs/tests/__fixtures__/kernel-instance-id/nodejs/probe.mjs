export const probe = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      provide() {
        return { kernelInstanceId: ctx.kernelInstanceId };
      },
    };
  },
};

export const report = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      run() {
        ctx.stdout.write(`${ctx.kernelInstanceId}\n`);
      },
    };
  },
};
