// Provides a condition as it was received; evaluates each tag template against
// the tag when invoked.
export const Probe = {
  async create(resource) {
    return { provide: async () => ({ condition: resource.condition }) };
  },
};

export const Tags = {
  async create(resource, ctx) {
    return { invoke: () => ctx.expandValue(resource.tags, { tag: { code: "t1" } }) };
  },
};
