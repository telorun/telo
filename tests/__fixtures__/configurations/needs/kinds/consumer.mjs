// Opens the fulfilment it holds and publishes the label it was given.
export const Consumer = {
  async create(resource, ctx) {
    return {
      init() {
        ctx.resolveNeed("/access");
      },
      snapshot() {
        return { label: resource.label };
      },
    };
  },
};

// Publishes the label it was given.
export const Labelled = {
  async create(resource) {
    return {
      snapshot() {
        return { label: resource.label };
      },
    };
  },
};
