// A provider whose first `init()` reports and then defers, and whose retry
// reports nothing — so a reading that survived the deferral is visible after boot.
export const deferring = {
  async create(resource, ctx) {
    let attempts = 0;
    return {
      async init() {
        attempts++;
        if (attempts > 1) return;
        await ctx.setStatus({ port: 1 });
        throw Object.assign(new Error("not this pass"), { code: "ERR_LOCAL_REF_PENDING" });
      },
    };
  },
};

// A service reporting from `init()`, which only a provider may do.
export const eagerService = {
  async create(resource, ctx) {
    return {
      async init() {
        await ctx.setStatus({ port: 1 });
      },
      async run() {},
    };
  },
};
