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
