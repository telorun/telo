import { InvokeError } from "@telorun/sdk";

export const Recurse = {
  async create(resource, ctx) {
    const limit = Number(resource.limit);
    return {
      async invoke(inputs) {
        const depth = Number(inputs.depth);
        if (depth >= limit) throw new InvokeError("ERR_BOTTOM", "bottom of the recursion");
        return ctx.invoke(resource.kind, resource.metadata.name, { depth: depth + 1 });
      },
    };
  },
};

export const Unready = {
  async create() {
    return {
      init() {
        throw new InvokeError("ERR_UNREADY", "the resource cannot start");
      },
    };
  },
};

export const Forward = {
  async create(resource, ctx) {
    return {
      async invoke() {
        return ctx.invoke("FailureRecursionKinds.Recurse", "missing", {});
      },
    };
  },
};

export const Fail = {
  async create() {
    return {
      async run() {
        throw new InvokeError("ERR_RUN_REFUSED", "the run refuses");
      },
    };
  },
};
