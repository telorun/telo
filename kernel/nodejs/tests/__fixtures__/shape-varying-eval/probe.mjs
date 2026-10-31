// Reports the value its `result.at` field arrived as.
export const Probe = {
  async create(resource) {
    return { provide: async () => resource.result.at };
  },
};
