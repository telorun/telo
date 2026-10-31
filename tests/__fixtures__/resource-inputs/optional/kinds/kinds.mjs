// A store publishing its label, and a holder publishing the label of the store
// it holds.
export const Store = {
  async create(resource) {
    return {
      label: resource.label,
      snapshot() {
        return { label: resource.label };
      },
    };
  },
};

export const Holder = {
  async create(resource) {
    return {
      snapshot() {
        return { label: resource.store.label };
      },
    };
  },
};

// Holds every member it lists.
export const Collector = {
  async create() {
    return {};
  },
};
