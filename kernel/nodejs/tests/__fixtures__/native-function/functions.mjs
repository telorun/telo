// Native function controllers for the native-function contract tests. Each
// records what it observed on a process-wide probe the test reads.
const probe = (globalThis.__nativeFunctionProbe ??= { contexts: [], released: 0 });

export const Pad = {
  async create(resource, ctx) {
    probe.contexts.push(Object.keys(ctx).sort());
    await ctx
      .effect("scratch buffer", async () => ({
        result: undefined,
        inverse: async () => {
          probe.released += 1;
        },
      }))
      .perform();
    return {
      call: ({ text, width }) => `${resource.fill}:${text}:${typeof width}:${width}`,
    };
  },
};

export const Wrong = {
  create() {
    return { call: () => 42 };
  },
};

export const Eventually = {
  create() {
    return { call: () => Promise.resolve("later") };
  },
};

export const AsyncCall = {
  create() {
    return { call: async () => "later" };
  },
};

export const NoCall = {
  create() {
    return {};
  },
};

export const NoCreate = {};
