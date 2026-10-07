// Provides the fields it was created with, as the kernel handed them over.
export const Table = {
  async create(resource) {
    return {
      provide: async () => ({
        title: resource.title,
        rowStyle: resource.rowStyle,
        values: (resource.columns ?? []).map((column) => column.value),
      }),
    };
  },
};

export const Read = {
  async create(resource) {
    return { invoke: () => resource.source.provide() };
  },
};
