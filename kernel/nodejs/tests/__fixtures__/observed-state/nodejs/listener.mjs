// A service that learns its address only when it runs — the shape `status:`
// exists for. `snapshot()` reports only what the author configured; what the
// resource observes is pushed with `ctx.setStatus()` at the moment it is known,
// so neither half is described twice.
export const listener = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      async init() {},
      async run() {
        const port = (resource.port ?? 0) + 51000;
        await ctx.setStatus({
          port,
          endpoint: `http://127.0.0.1:${port}/callback`,
        });
      },
      snapshot() {
        // The flat half keeps its existing meaning: what the author asked for.
        return { port: resource.port ?? 0 };
      },
    };
  },
};

/** Config resolved once at startup — never a slot for observed state. */
export const startupConsumer = {
  schema: { type: "object", additionalProperties: true },
  async create() {
    return {
      async init() {},
      snapshot() {
        return {};
      },
    };
  },
};

/** Reports observed state without declaring `status:` — the undeclared case. */
export const undeclaredReporter = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      async run() {
        await ctx.setStatus({ surprise: true });
      },
      snapshot() {
        return {};
      },
    };
  },
};

/** Declares NO `status:` of its own — everything it reports is mandated by the
 *  contract it extends. Regresses to ERR_OBSERVED_STATE_UNDECLARED if that chain
 *  is folded anywhere but the declaring library's scope. */
export const inheritedOnly = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      async run() {
        await ctx.setStatus({ endpoint: "http://127.0.0.1:9/inherited" });
      },
      snapshot() {
        return {};
      },
    };
  },
};
