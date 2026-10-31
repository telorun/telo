// Runs the member `pick` names inside one run of the `members` scope.
export const Host = {
  async create(resource) {
    return {
      invoke: () => resource.members.run((scope) => scope.getInstance(resource.pick).invoke({})),
    };
  },
};

// Invokes the target it holds, when one is given, then returns its answer.
export const Target = {
  async create(resource, ctx) {
    return {
      invoke: async () => {
        if (resource.target !== undefined) {
          const target =
            typeof resource.target?.invoke === "function"
              ? resource.target
              : ctx.resolveRef(resource.target, (c) => typeof c?.invoke === "function", () => "'target'", "Telo.Invocable");
          await target.invoke({});
        }
        return { answer: await ctx.expandValue(resource.answer, {}) };
      },
    };
  },
};

// Reports how many times it has run.
export const Counter = {
  async create(resource, ctx) {
    let runs = 0;
    return {
      run: async () => {
        runs += 1;
        await ctx.setStatus({ runs });
      },
    };
  },
};
