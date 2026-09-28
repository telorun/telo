// A schema instance as an engine module older than table addressing builds it:
// it offers no `qualifiedTableName`.
export const schema = {
  async create() {
    return {
      async run() {},
      snapshot() {
        return {};
      },
    };
  },
};
