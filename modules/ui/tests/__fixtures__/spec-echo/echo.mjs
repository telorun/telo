// Provides exactly what it was declared with, so a test can hand a renderer's
// contract a value no kind of the vocabulary would produce.
export const Surface = {
  async create(resource) {
    return { provide: async () => resource.spec };
  },
};

export const Composite = {
  async create(resource) {
    return { provide: async () => ({ node: resource.node, assets: [] }) };
  },
};
