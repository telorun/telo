// An invocable returning the value it was configured with — what a compile-time
// field evaluated to when the resource was created.
export const Echo = {
  async create(resource) {
    return { invoke: async () => resource.value };
  },
};
