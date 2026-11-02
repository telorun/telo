// Counts how often each resource is created.
globalThis.inheritedLayersCreates = {};

export const Base = {
  async create(resource) {
    const name = resource.metadata.name;
    globalThis.inheritedLayersCreates[name] = (globalThis.inheritedLayersCreates[name] ?? 0) + 1;
    return { invoke: async (inputs) => inputs };
  },
};
