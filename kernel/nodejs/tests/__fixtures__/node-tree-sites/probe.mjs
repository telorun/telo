// Provides the content it was created with.
export const Card = {
  async create(resource) {
    return { provide: async () => resource.content };
  },
};
