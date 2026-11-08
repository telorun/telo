// Publishes the parameters `ctx.resolveNeed` hands over for its printer.
export const Labeler = {
  async create(resource, ctx) {
    let opened;
    return {
      init() {
        opened = ctx.resolveNeed("/printer");
      },
      snapshot() {
        return { logo: opened?.parameters?.logo ?? null };
      },
    };
  },
};
