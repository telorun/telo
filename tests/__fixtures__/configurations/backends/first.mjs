// An in-memory fixture backend answering with its own name.
export const first = {
  schema: { type: "object", additionalProperties: true },
  async create() {
    return {
      async invoke() {
        return { backend: "first" };
      },
      snapshot() {
        return {};
      },
    };
  },
};
