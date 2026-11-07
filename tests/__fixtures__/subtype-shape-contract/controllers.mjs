export const Echo = {
  async create() {
    return {
      async invoke(inputs) {
        return inputs;
      },
    };
  },
};
