// Provides the fields it was created with, as the kernel handed them over.
export const Criteria = {
  async create(resource) {
    return { provide: async () => ({ criteria: resource.criteria }) };
  },
};

export const Read = {
  async create(resource) {
    return { invoke: () => resource.source.provide() };
  },
};
