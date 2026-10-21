// Evaluates a notice's texts when it is invoked; provides a row's label and the
// bindings its values are named by.
export const Notice = {
  async create(resource, ctx) {
    return {
      invoke: () => ({
        title: ctx.expandValue(resource.title, {}),
        banner: ctx.expandValue(resource.banner, { who: "Ala" }),
      }),
    };
  },
};

export const Row = {
  async create(resource) {
    return { provide: async () => ({ label: resource.label, values: resource.values }) };
  },
};
