// Reads a provider, so a manifest test can assert on what it provides.
export const Read = {
  async create(resource) {
    return { invoke: () => resource.source.provide() };
  },
};
