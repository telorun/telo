export const Box = {
  async create(resource) {
    return {
      async invoke(inputs) {
        return { message: inputs?.message ?? resource.seed };
      },
    };
  },
};
