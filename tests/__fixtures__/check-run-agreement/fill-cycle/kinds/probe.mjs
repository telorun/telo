// Provides nothing: the fixture kinds exist to be checked and created.
export const Holder = {
  async create() {
    return { provide: async () => ({}) };
  },
};
