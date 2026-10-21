// Evaluates its texts in one call, as a controller builds a value around the
// fields it holds, and returns what the evaluation produced.
export const Notice = {
  create(resource, ctx) {
    return {
      invoke: ({ who }) =>
        ctx.expandValue(
          { title: resource.title, banner: resource.banner, fixed: resource.fixed, values: resource.values },
          { who },
        ),
    };
  },
};
