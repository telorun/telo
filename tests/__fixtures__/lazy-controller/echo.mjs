// A trivial bundled Invocable. Instantiated by the test, so its module IS
// imported — proving used kinds still load lazily on first instantiation.
export const echo = {
  schema: { type: "object", additionalProperties: true },
  async create() {
    return {
      async invoke(inputs) {
        return { text: String(inputs?.text ?? "") };
      },
      snapshot() {
        return {};
      },
    };
  },
};
