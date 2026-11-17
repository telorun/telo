// Pick provides the accessor binding it was created with; Read returns what
// the provider it holds provides.
export const Pick = {
  async create(resource) {
    return { provide: async () => resource.value };
  },
};

export const Read = {
  async create(resource) {
    return { invoke: () => resource.source.provide() };
  },
};
