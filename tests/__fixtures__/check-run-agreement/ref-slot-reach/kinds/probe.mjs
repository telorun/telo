// Each probe reports, per reference it holds, whether Phase 5 handed it over as
// the live instance, and what that instance returns when invoked. One that did
// not arrive live is resolved through `ctx.resolveRef`, which refuses a name
// that resolves to nothing.
const isInvocable = (candidate) => typeof candidate?.invoke === "function";
const probe = async (value, ctx, describe) => {
  const injected = isInvocable(value);
  const target = injected ? value : ctx.resolveRef(value, isInvocable, describe, "Telo.Invocable");
  return { injected, result: await target.invoke({}) };
};

export const Target = {
  async create(resource, ctx) {
    return { invoke: () => probe(resource.target, ctx, () => "'target'") };
  },
};

// Every configured key of an open-keyed resource, in key order.
export const Mapped = {
  async create(resource, ctx) {
    return {
      invoke: async () => {
        const out = {};
        for (const key of Object.keys(resource).sort()) {
          if (key === "kind" || key === "metadata") continue;
          out[key] = await probe(resource[key], ctx, () => `'${key}'`);
        }
        return out;
      },
    };
  },
};

// The `target` at each depth of a `node` / `next` chain that holds one.
export const Chain = {
  async create(resource, ctx) {
    return {
      invoke: async () => {
        const out = [];
        for (let node = resource.node, depth = 1; node; node = node.next, depth++) {
          if (node.target === undefined) continue;
          out.push({ depth, ...(await probe(node.target, ctx, () => `'target' at depth ${depth}`)) });
        }
        return out;
      },
    };
  },
};

// Invokes the scope member `pick` names, inside one run of the `with:` scope.
export const Scoped = {
  async create(resource) {
    return {
      invoke: async () => {
        const handle = resource.with;
        if (typeof handle?.run !== "function") return { handle: false, result: null };
        const result = await handle.run((scope) => scope.getInstance(resource.pick).invoke({}));
        return { handle: true, result };
      },
    };
  },
};

// Returns the inputs it was invoked with.
export const Echo = {
  async create() {
    return { invoke: async (inputs) => inputs };
  },
};

// Invokes a `{ handler, inputs }` entry's handler with the inputs written beside it.
const callEntry = (entry) => entry.handler.invoke(entry.inputs);

export const PairedRoutes = {
  async create(resource) {
    return { invoke: () => Promise.all(resource.routes.map(callEntry)) };
  },
};

export const PairedRoot = {
  async create(resource) {
    return { invoke: () => callEntry(resource) };
  },
};

// Every configured key of an open-keyed resource, in key order.
export const PairedMap = {
  async create(resource) {
    return {
      invoke: async () => {
        const out = {};
        for (const key of Object.keys(resource).sort()) {
          if (key === "kind" || key === "metadata") continue;
          out[key] = await callEntry(resource[key]);
        }
        return out;
      },
    };
  },
};

// The target it holds, as the kernel handed it over.
export const Received = {
  async create(resource) {
    return { invoke: async () => resource.target };
  },
};

export const ReceivedInner = {
  async create(resource) {
    return { invoke: async () => resource.inner.target };
  },
};
