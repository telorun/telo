// Provides the accessor it was created with.
export const Column = {
  async create(resource) {
    return { provide: async () => ({ value: resource.value }) };
  },
};
