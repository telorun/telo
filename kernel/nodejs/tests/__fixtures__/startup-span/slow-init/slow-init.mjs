export const SlowInit = {
  async create() {
    return {
      async init() {
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
      async invoke() {
        return {};
      },
    };
  },
};
