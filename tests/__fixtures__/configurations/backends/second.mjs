// An in-memory fixture backend answering with its own name.
export const second = {
  schema: { type: "object", additionalProperties: true },
  async create() {
    return {
      async invoke() {
        return { backend: "second" };
      },
      snapshot() {
        return {};
      },
    };
  },
};
