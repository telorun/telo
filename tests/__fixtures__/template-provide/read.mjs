// Returns what the provider it holds provides.
export const Read = {
  async create(resource) {
    return { invoke: () => resource.source.provide() };
  },
};
