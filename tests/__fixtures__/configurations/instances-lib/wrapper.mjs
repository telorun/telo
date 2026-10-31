// Holds the store it is given and answers nothing of its own.
export const Wrapper = {
  schema: { type: "object", additionalProperties: true },
  async create() {
    return {
      async invoke() {
        return {};
      },
      snapshot() {
        return {};
      },
    };
  },
};
